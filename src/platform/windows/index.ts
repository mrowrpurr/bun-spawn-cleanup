/**
 * Windows backend: Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE.
 *
 * Strategy (self-assign):
 *   1. Create an unnamed job, set KILL_ON_JOB_CLOSE, assign the CURRENT process to it.
 *   2. Every process we spawn afterwards, and everything those spawn, inherits membership.
 *      No per-child race: a child is in the job from its very first instruction.
 *   3. Hold the only handle forever and never close it. Process death, by any means
 *      (crash, taskkill /F, Stop-Process, clean exit, uncaught throw), closes the handle and
 *      the kernel terminates every remaining member.
 *   4. No breakaway flags are permitted, so CREATE_BREAKAWAY_FROM_JOB is refused to
 *      descendants (ERROR_ACCESS_DENIED).
 *
 * This is a PROCESS-WIDE side effect: once active, everything this Bun process starts, by
 * any API, is in the job and dies with it. It happens when `configureSpawnCleanup()` runs,
 * which the root entry does at import. No options apply on Windows beyond `disable`.
 *
 * Known escapes (documented in test/windows-escapes.test.ts): processes created on a
 * descendant's behalf by a broker that lives OUTSIDE the job, e.g. WMI `Win32_Process.Create`
 * (WmiPrvSE.exe), Task Scheduler, UAC elevation (AppInfo), out-of-proc COM servers. Those are
 * not children of anything in the job and the kernel has no reason to kill them.
 *
 * Per-spawn tracking for `killTree`: each spawned child is also assigned to its own empty
 * nested job (Windows 8+ nested jobs). Grandchildren spawned after that assignment land in it,
 * so `TerminateJobObject` kills exactly that subtree. The nested job carries no kill-on-close
 * limit, so a grandchild that outlives its parent is still owned by the top-level job and dies
 * with the owner, not with its parent. The nested job handle is kept while the job still has
 * live processes (so `killTree` reaches daemonized grandchildren after the direct child exits)
 * and released once it is empty. Grandchildren the child manages to start in the few
 * microseconds between `Bun.spawn` returning and the nested assignment are missed by
 * `killTree` but still die with the owner.
 *
 * Adoption: right after self-assignment, `ensure()` walks a toolhelp snapshot for every live
 * descendant of this process (spawned before setup) and assigns each into the owner job.
 * A parent link only counts when the child was created after the parent, so a stale parent
 * pid that Windows reused for us (or for a descendant) never pulls an unrelated process into
 * a job that kills it. Failures are tolerated and only counted: a descendant already in a
 * job that cannot nest under ours, access denied, or a pid that exited mid-walk.
 *
 * `killAll()` terminates every member of the owner job except this process: everything
 * spawned or adopted, at any depth, including grandchildren that never reached a nested job.
 */
import {
  disabledBy,
  type CleanupBackend,
  type CleanupOptions,
  type CleanupStatus,
  type KillTreeResult,
  type SpawnedProcess,
} from "../../backend.ts";
import {
  closeQuietly,
  IS_WINDOWS,
  isProcessInJob,
  jobActiveProcesses,
  jobProcessIds,
  kernel32LoadError,
  lastError,
  loadKernel32,
  PROCESS_QUERY_LIMITED_INFORMATION,
  PROCESS_SET_QUOTA,
  PROCESS_TERMINATE,
  processCreationTime,
  SYNCHRONIZE,
  processParentMap,
  setJobLimitFlags,
  withProcessHandle,
  type Kernel32,
  type Ptr,
} from "./ffi.ts";

const BACKEND = "windows-job-object";
/** Upper bound killAll() waits, in total, for terminated members to actually exit. */
const KILL_ALL_WAIT_MS = 2_000;

export function createWindowsBackend(): CleanupBackend {
  /**
   * Module-lifetime strong reference to the top-level job handle. Closing the LAST handle to
   * a KILL_ON_JOB_CLOSE job is precisely what kills its members, so this must live as long as
   * the process and must NEVER be passed to CloseHandle. Process exit closes it for us.
   */
  let ownerJob: Ptr = null;
  let memo: CleanupStatus | undefined;
  /** Per-spawn nested jobs, keyed by child pid, for killTree. */
  const childJobs = new Map<number, { hJob: Ptr; childExited: boolean }>();

  const fail = (reason: string): CleanupStatus => ({
    platform: "windows",
    backend: BACKEND,
    guarantee: "kernel",
    active: false,
    reason,
  });

  function ensure(options?: CleanupOptions): CleanupStatus {
    if (memo) return memo;
    memo = (() => {
      if (!IS_WINDOWS) return fail("not windows");
      const disabled = disabledBy(options);
      if (disabled) return fail(disabled);
      try {
        const k32 = loadKernel32();
        if (!k32) return fail(kernel32LoadError() ?? "dlopen(kernel32.dll) failed");

        // Unnamed job: nothing else can open it by name and hold it alive past our death.
        const hJob = k32.symbols.CreateJobObjectW(null, null);
        if (!hJob) return fail(`CreateJobObjectW failed, GetLastError=${lastError(k32)}`);

        if (!setJobLimitFlags(k32, hJob)) {
          const e = lastError(k32);
          closeQuietly(k32, hJob);
          return fail(`SetInformationJobObject failed, GetLastError=${e}`);
        }

        const self = k32.symbols.GetCurrentProcess();
        if (!k32.symbols.AssignProcessToJobObject(hJob, self)) {
          const e = lastError(k32);
          closeQuietly(k32, hJob);
          return fail(`AssignProcessToJobObject(self) failed, GetLastError=${e}`);
        }

        // From here on we ARE in a kill-on-close job and must never close hJob: closing it
        // would kill ourselves. Verify against OUR handle, never NULL (NULL means "any job"
        // and Windows' ambient console job would make that a false positive).
        ownerJob = hJob;
        const inJob = isProcessInJob(k32, self, hJob);
        const inJobError = inJob === undefined ? lastError(k32) : 0;
        const adoption = adoptDescendants(k32, hJob);
        const notes: string[] = [];
        if (inJob === undefined) {
          // Assignment succeeded, only the sanity query failed. The guarantee is in force.
          notes.push(`IsProcessInJob query failed, GetLastError=${inJobError}; assuming assigned`);
        }
        if (adoption.adopted < adoption.found) {
          notes.push(`adopted ${adoption.adopted} of ${adoption.found} pre-existing descendant(s)`);
        }
        const base: CleanupStatus = { platform: "windows", backend: BACKEND, guarantee: "kernel", active: true };
        if (inJob !== false) return notes.length ? { ...base, reason: notes.join("; ") } : base;
        // Assignment reported success but the kernel says we are not a member. Should be
        // impossible; report it but keep the handle (we may well be a member).
        return fail("IsProcessInJob returned false after a successful AssignProcessToJobObject");
      } catch (err) {
        return fail(`job setup threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return memo;
  }

  /**
   * Assign every live descendant of this process into `hJob`, breadth-first from our own pid
   * over one toolhelp snapshot. A child counts only if it was created no earlier than its
   * nearest verified ancestor (guards against reused parent pids). Never throws.
   */
  function adoptDescendants(k32: Kernel32, hJob: Ptr): { found: number; adopted: number } {
    let found = 0;
    let adopted = 0;
    try {
      const parents = processParentMap(k32);
      if (!parents) return { found, adopted };
      const children = new Map<number, number[]>();
      for (const [pid, ppid] of parents) {
        if (pid === ppid || pid === 0) continue;
        const list = children.get(ppid);
        if (list) list.push(pid);
        else children.set(ppid, [pid]);
      }
      const selfTime = processCreationTime(k32, k32.symbols.GetCurrentProcess());
      if (selfTime === undefined) return { found, adopted };
      const seen = new Set<number>([process.pid]);
      // Each queue item carries the creation time of its nearest verified ancestor.
      const queue: Array<[number, bigint]> = [[process.pid, selfTime]];
      while (queue.length) {
        const [parent, bound] = queue.shift()!;
        for (const pid of children.get(parent) ?? []) {
          if (seen.has(pid)) continue;
          seen.add(pid);
          let h: Ptr = null;
          try {
            h = k32.symbols.OpenProcess(
              PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
              0,
              pid,
            );
            // Only VERIFIED nodes count or extend the walk. A process we cannot open, or whose
            // creation time we cannot read, may be an unrelated process hanging off a reused
            // pid; descending through it could pull strangers into a kill-on-close job.
            if (!h) continue;
            const created = processCreationTime(k32, h);
            if (created === undefined || created < bound) continue; // unverifiable or stale link
            found++;
            if (k32.symbols.AssignProcessToJobObject(hJob, h) !== 0) adopted++;
            queue.push([pid, created]);
          } catch {
            /* tolerated: counted as found, not adopted */
          } finally {
            closeQuietly(k32, h);
          }
        }
      }
    } catch {
      /* adoption is best-effort; setup itself already succeeded */
    }
    return { found, adopted };
  }

  function k32IfActive(): Kernel32 | undefined {
    if (!ensure().active) return undefined;
    return loadKernel32();
  }

  /**
   * Drop nested jobs whose direct child exited and that have no live members left. With
   * `emptyToo`, also drop any nested job the kernel already reports empty, before the child's
   * exit promise resolved (after `killAll`); a failed query keeps those.
   */
  function sweep(k32: Kernel32, emptyToo = false): void {
    for (const [pid, entry] of childJobs) {
      if (!entry.childExited && !emptyToo) continue;
      const active = jobActiveProcesses(k32, entry.hJob);
      if (!entry.childExited && active !== 0) continue;
      if (active === 0 || active === undefined) {
        childJobs.delete(pid);
        closeQuietly(k32, entry.hJob);
      }
    }
  }

  function track(proc: SpawnedProcess): void {
    const k32 = k32IfActive();
    if (!k32) return;
    const pid = proc.pid;
    if (!pid || childJobs.has(pid)) return;
    try {
      sweep(k32);
      const hJob = k32.symbols.CreateJobObjectW(null, null);
      if (!hJob) return;
      // Nested job: empty job + process already in our top-level job => hJob nests under it.
      // PROCESS_SET_QUOTA | PROCESS_TERMINATE is the documented minimum for assignment.
      const ok = withProcessHandle(
        k32,
        pid,
        PROCESS_SET_QUOTA | PROCESS_TERMINATE,
        (h) => k32.symbols.AssignProcessToJobObject(hJob, h) !== 0,
      );
      if (!ok) {
        closeQuietly(k32, hJob);
        return;
      }
      const entry = { hJob, childExited: false };
      childJobs.set(pid, entry);
      const onExit = () => {
        entry.childExited = true;
        sweep(k32);
      };
      proc.exited.then(onExit, onExit);
    } catch {
      /* tracking is an enhancement; the top-level job is the guarantee */
    }
  }

  function killTree(pid: number): KillTreeResult {
    const entry = childJobs.get(pid);
    const k32 = loadKernel32();
    if (entry === undefined || !k32) {
      return { tracked: false, detail: "pid not tracked by a nested job" };
    }
    try {
      if (k32.symbols.TerminateJobObject(entry.hJob, 1) !== 0) {
        return { tracked: true, detail: "TerminateJobObject on nested job" };
      }
      return { tracked: false, detail: `TerminateJobObject failed, GetLastError=${lastError(k32)}` };
    } catch (err) {
      return { tracked: false, detail: `TerminateJobObject threw: ${err instanceof Error ? err.message : String(err)}` };
    } finally {
      sweep(k32);
    }
  }

  function killAll(): KillTreeResult {
    try {
      const k32 = k32IfActive();
      if (!k32 || ownerJob === null) {
        return { tracked: false, detail: `owner job not active: ${memo?.reason ?? "not configured"}` };
      }
      const pids = jobProcessIds(k32, ownerJob);
      if (!pids) {
        return {
          tracked: false,
          detail: `QueryInformationJobObject(JobObjectBasicProcessIdList) failed, GetLastError=${lastError(k32)}`,
        };
      }
      const targets = pids.filter((pid) => pid !== process.pid);
      let terminated = 0;
      const pending: Ptr[] = [];
      for (const pid of targets) {
        const h = k32.symbols.OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, 0, pid);
        if (!h) continue; // already gone, or not openable: the re-query below decides
        if (k32.symbols.TerminateProcess(h, 1) !== 0) terminated++;
        pending.push(h);
      }
      // TerminateProcess is asynchronous: wait (bounded) for the kills to land before
      // re-querying, so a member still tearing down is not reported as a survivor.
      const deadline = Date.now() + KILL_ALL_WAIT_MS;
      for (const h of pending) {
        try {
          k32.symbols.WaitForSingleObject(h, Math.max(0, deadline - Date.now()));
        } finally {
          closeQuietly(k32, h);
        }
      }
      sweep(k32, true);
      const summary = `terminated ${terminated} of ${targets.length} job member(s)`;
      const after = jobProcessIds(k32, ownerJob);
      if (!after) {
        return { tracked: false, detail: `${summary}; re-query failed, GetLastError=${lastError(k32)}` };
      }
      const survivors = after.filter((pid) => pid !== process.pid);
      if (survivors.length) {
        return { tracked: false, detail: `${summary}; ${survivors.length} survivor(s): ${survivors.join(", ")}` };
      }
      return { tracked: true, detail: summary };
    } catch (err) {
      return { tracked: false, detail: `killAll threw: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  function isContained(pid: number): boolean | undefined {
    const k32 = k32IfActive();
    if (!k32 || ownerJob === null) return undefined;
    return withProcessHandle(k32, pid, PROCESS_QUERY_LIMITED_INFORMATION, (h) =>
      isProcessInJob(k32, h, ownerJob),
    );
  }

  return {
    name: BACKEND,
    platform: "windows",
    guarantee: "kernel",
    ensure,
    status: () => memo ?? fail("not configured; configureSpawnCleanup() has not run"),
    killAll,
    track,
    killTree,
    isContained,
  };
}
