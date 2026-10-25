/**
 * Linux backend. Two mechanisms, chosen at `ensure()` time and reported through `status()`:
 *
 * 1. `linux-cgroup2+landlock` (guarantee: kernel) / `linux-cgroup2` (best-effort). The owner creates a
 *    child cgroup under the cgroup it is already in, starts a detached supervisor (see
 *    supervisor.ts) that holds the other end of a pipe, moves ITSELF into the cgroup, and
 *    then applies a Landlock ruleset (see landlock.ts) that denies every write under the
 *    cgroup2 mount and, on kernel 6.12+, every signal to a process outside the sandbox.
 *    Every process the owner spawns from then on, and everything they spawn, is born inside
 *    the cgroup AND inside the Landlock domain, which is inherited and irrevocable:
 *    `setsid`, `nohup`, double-fork, `disown`, `env -i` and reparenting do not change
 *    cgroup membership, and a descendant cannot write its pid into another cgroup.procs
 *    (EACCES) or kill the supervisor (EPERM). When the owner dies by any means the pipe
 *    hits EOF and the supervisor writes `1` to `cgroup.kill`, which SIGKILLs the whole
 *    subtree atomically. Because the owner can no longer write cgroupfs itself, per-spawn
 *    cgroups for `killTree` are created and killed by the supervisor on command.
 *
 *    Needs a user-writable cgroup v2 directory: a systemd user service or `systemd-run
 *    --user --scope` has one (the whole `user@<uid>.service` tree is delegated), and for a
 *    plain login session we ask the user's systemd instance to move us into a transient
 *    scope, which gives us one. Without Landlock (kernel < 5.13, or not in the `lsm=` list)
 *    or without its signal scoping (ABI < 6) the cgroup part still works but a deliberate
 *    same-UID descendant can leave the cgroup or kill the supervisor, so it is reported as
 *    `best-effort` with a reason naming the hole. A nested owner (a descendant that also
 *    uses this library) finds itself inside a `bsc-*` cgroup, creates none of its own, and
 *    runs the best-effort mechanism inside the outer owner's kernel containment.
 *
 *    What remains (asserted in test/linux-cgroup.test.ts): brokers that launch on a
 *    descendant's behalf from outside the cgroup, `systemd-run --user` (the user manager
 *    forks the service), at/cron, D-Bus activation. Same shape as WMI on Windows; no
 *    unprivileged mechanism on any OS closes IPC to a daemon that spawns processes.
 *
 * 2. `linux-best-effort` (guarantee: best-effort). Used when no writable cgroup v2 exists
 *    (non-root in a container, no systemd user instance, cgroup v1 host, kernel < 5.14, or
 *    forced via env). Process-wide: at setup the owner becomes a child subreaper
 *    (`PR_SET_CHILD_SUBREAPER`, see subreaper.ts), so every orphaned descendant reparents to
 *    the owner instead of init and the whole tree, whatever API created it (`Bun.spawn`,
 *    `child_process`, a plugin) and however it double-forked, stays reachable through
 *    /proc parent links. The supervisor snapshots that set once a second and, when the
 *    owner dies, freezes and kills the last snapshot plus everything whose parent chain
 *    reaches it (see supervisor.ts). `spawn()` is byte-for-byte `Bun.spawn`: no env
 *    injection. `BUN_SPAWN_CLEANUP_ID` is still stamped into `process.env` so callers that
 *    pass `{ ...process.env }` carry it, and the supervisor still kills marker carriers as a
 *    second net; only if the prctl fails does `spawn()` fall back to injecting the marker
 *    (the old mechanism), and the status reason says so. Escapes: a deliberate `setsid` plus
 *    a kill of the supervisor, brokers, and a non-library descendant created and orphaned
 *    within the last second before the owner died. `killTree(child)` kills the child's
 *    current descendants plus a per-spawn snapshot (refreshed every 250 ms and on every
 *    track/killTree), so it still works after the child itself exited, for the descendants
 *    the snapshot saw.
 *
 * Both mechanisms, on setup: ADOPT the owner's existing descendants (the /proc parent walk:
 *    moved into the owner's cgroup, or simply reachable under the subreaper), and, in cgroup
 *    mode, SWEEP sibling `bsc-<pid>-<hex>` cgroups whose owner is dead (see sweep.ts).
 *    While the owner lives, a supervisor that exits is RESTARTED (5 restarts per 60 s, then
 *    `active: false`); see `watchSupervisor`. `killTree()` with no argument (`killAll`)
 *    kills every descendant and leaves the owner and its supervisor alive.
 *
 * Why not a PID namespace (the research's other kernel option): `unshare(CLONE_NEWUSER)`
 * returns EINVAL in a multithreaded process and Bun is multithreaded, so the unprivileged
 * route is impossible from inside the owner, and `unshare(CLONE_NEWPID)` alone needs
 * CAP_SYS_ADMIN, in which case the caller is root and has cgroup v2 anyway.
 *
 * Knobs, each as a `configureSpawnCleanup()` option or an env var (option wins; both read
 * once at setup): `disable` / `BUN_SPAWN_CLEANUP_DISABLE=1` turns the backend off;
 * `linux.mechanism` / `BUN_SPAWN_CLEANUP_LINUX_MECHANISM=auto|cgroup|best-effort` pins a
 * mechanism (`cgroup` reports `active: false` instead of falling back when cgroups are
 * unusable); `linux.landlock: false` / `BUN_SPAWN_CLEANUP_LINUX_LANDLOCK=0` skips Landlock
 * (for owners whose descendants must run setuid programs such as sudo or snap, which
 * `no_new_privs` prevents). Setup happens when `configureSpawnCleanup()` runs, which the
 * root entry does at import: cgroup created, supervisor started, Landlock applied, there.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  disabledBy,
  envFlag,
  type CleanupBackend,
  type CleanupOptions,
  type CleanupStatus,
  type Guarantee,
  type KillTreeResult,
  type SpawnedProcess,
} from "../../backend.ts";
import {
  cgroup2Root,
  isPopulated,
  joinCgroup,
  killCgroup,
  makeCgroup,
  moveSelfToTransientScope,
  moveToCgroup,
  readCgroupFile,
  removeCgroup,
} from "./cgroup.ts";
import { restrictCgroupWrites } from "./landlock.ts";
import {
  cgroupPathOf,
  descendantsOf,
  environHasMarker,
  parentPid,
  pidExists,
  procStat,
  procTable,
  startTimeOf,
  stopAndKill,
  type ProcStat,
} from "./proc.ts";
import { becomeSubreaper, reapAdoptedZombies } from "./subreaper.ts";
import { CGROUP_SUPERVISOR, MARKER_SUPERVISOR, startSupervisor, type Supervisor } from "./supervisor.ts";
import { cgroupMembers, MARKER_ENV, OWN_CGROUP_RE, sweepDeadOwners } from "./sweep.ts";

export { MARKER_ENV, OWN_CGROUP_RE };

export const BACKEND_CGROUP = "linux-cgroup2";
export const BACKEND_CGROUP_LANDLOCK = "linux-cgroup2+landlock";
export const BACKEND_MARKER = "linux-best-effort";
/** `auto` (default) | `cgroup` | `best-effort`. */
export const MECHANISM_ENV = "BUN_SPAWN_CLEANUP_LINUX_MECHANISM";
/** Set to `0` to skip Landlock in cgroup mode. */
export const LANDLOCK_ENV = "BUN_SPAWN_CLEANUP_LINUX_LANDLOCK";

/** Supervisor restarts allowed within `RESTART_WINDOW_MS`; the next exit gives up. */
export const RESTART_LIMIT = 5;
export const RESTART_WINDOW_MS = 60_000;

type Mechanism = "auto" | "cgroup" | "best-effort";

/** Option over env; default on. */
function landlockWanted(options: CleanupOptions | undefined): boolean {
  return options?.linux?.landlock ?? envFlag(LANDLOCK_ENV) ?? true;
}

/** Option over env; default `auto`. Unknown env values fall back to `auto`. */
function requestedMechanism(options: CleanupOptions | undefined): Mechanism {
  if (options?.linux?.mechanism) return options.linux.mechanism;
  const v = (process.env[MECHANISM_ENV] ?? "auto").trim().toLowerCase();
  return v === "cgroup" || v === "best-effort" ? v : "auto";
}

/** What a mechanism does right after a replacement supervisor started. */
interface RestartFixup {
  /** Guarantee from now on, when the restart weakened it. */
  guarantee?: Guarantee;
  /** Appended to the status reason. */
  note?: string;
  /** SIGKILL the old supervisor's process group (its poller), if it survived. */
  abortOld?: boolean;
}

/** The part of the backend that differs per mechanism. */
interface Strategy {
  readonly name: string;
  readonly guarantee: Guarantee;
  /** Note carried into an ACTIVE status, e.g. why a hardening step is missing. */
  readonly note?: string;
  track(proc: SpawnedProcess): void;
  killTree(pid: number): KillTreeResult;
  killAll(): KillTreeResult;
  isContained(pid: number): boolean | undefined;
  spawnEnv(): Record<string, string> | undefined;
  /** Called after the backend started a replacement supervisor. */
  onRestart(sup: Supervisor): RestartFixup;
}

const IS_LINUX = process.platform === "linux";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createLinuxBackend(): CleanupBackend {
  let memo: CleanupStatus | undefined;
  /** Status as of setup; restarts derive the live status from it. */
  let base: CleanupStatus | undefined;
  let strategy: Strategy | undefined;
  /** Module-lifetime reference: the supervisor's stdin pipe must stay open until we die. */
  let supervisor: Supervisor | undefined;
  /** How the current supervisor was started, so a restart can do exactly the same. */
  let supSpec: { script: string; token: string; config: string; env: Record<string, string> } | undefined;
  /**
   * Pid of every supervisor ever started. Each is a session leader (`detached`), so its
   * poller and helpers carry its pid as their sid: that is how they are kept out of
   * adoption, killAll, snapshots and `isContained`, wherever they ended up reparented.
   */
  const supervisorSids = new Set<number>();
  const isSupervisor = (pid: number, st?: ProcStat): boolean => {
    if (supervisorSids.has(pid)) return true;
    const s = st ?? procStat(pid);
    return s !== undefined && supervisorSids.has(s.sid);
  };

  const fail = (backend: string, guarantee: Guarantee, reason: string): CleanupStatus => ({
    platform: "linux",
    backend,
    guarantee,
    active: false,
    reason,
  });

  function launchSupervisor(script: string, token: string, config: string, env: Record<string, string>): Supervisor {
    const sup = startSupervisor(script, token, config, env);
    supSpec = { script, token, config, env };
    supervisorSids.add(sup.pid);
    supervisor = sup;
    return sup;
  }

  // -------------------------------------------------------------------------------------
  // cgroup v2
  // -------------------------------------------------------------------------------------

  function setupCgroup(options: CleanupOptions | undefined): { strategy: Strategy } | { reason: string } | { nested: string } {
    const root = cgroup2Root();
    if (!root) return { reason: "no cgroup2 mount (cgroup v1 host?)" };
    let path = cgroupPathOf("self");
    if (path === undefined) return { reason: "/proc/self/cgroup has no `0::` entry (cgroup v1 host?)" };
    if (path.split("/").some((seg) => OWN_CGROUP_RE.test(seg))) {
      // We are a descendant of another owner that uses this library. Its cgroup already
      // contains us and everything we will spawn, and its Landlock ruleset forbids us from
      // creating cgroups anyway. Never take the transient-scope route from here: that would
      // move us OUT of the outer owner's cgroup.
      return {
        nested: `nested inside another bun-spawn-cleanup owner's cgroup (${path}); its kernel cleanup already covers this process, so no cgroup of our own`,
      };
    }
    let parentDir = joinCgroup(root, path);
    if (!existsSync(`${parentDir}/cgroup.kill`)) {
      return { reason: `${parentDir}/cgroup.kill missing (kernel < 5.14, or cgroup dir not visible)` };
    }

    const suffix = `${process.pid}-${randomBytes(3).toString("hex")}`;
    const ownName = `bsc-${suffix}`;
    let ownDir = `${parentDir}/${ownName}`;
    let mkdirErr = makeCgroup(ownDir);
    let tookScope = false;
    if (mkdirErr !== undefined) {
      // Not writable here (typically a root-owned session scope). Ask systemd --user for a
      // delegated transient scope of our own and try again inside it. Our existing
      // descendants go into the same scope (adoption), else they would stay behind in a
      // cgroup we cannot move them out of; systemd refuses the whole call if one of them
      // vanished meanwhile, hence the retry without them.
      // Unit name without "bun" or the package name: it ends up in our cgroup path, which is
      // visible in `ps` output of anything that mentions it.
      const pre = descendantsOf(process.pid, (pid, st) => isSupervisor(pid, st));
      let moved = moveSelfToTransientScope(process.pid, `bsc-scope-${suffix}.scope`, pre);
      if ("reason" in moved && pre.length) moved = moveSelfToTransientScope(process.pid, `bsc-scope-${suffix}-solo.scope`);
      if ("reason" in moved) {
        return { reason: `cannot create a cgroup under ${parentDir} (${mkdirErr}); transient scope: ${moved.reason}` };
      }
      tookScope = true;
      path = moved.path;
      parentDir = joinCgroup(root, path);
      ownDir = `${parentDir}/${ownName}`;
      mkdirErr = makeCgroup(ownDir);
      if (mkdirErr !== undefined) return { reason: `moved into ${path} but mkdir there failed (${mkdirErr})` };
    }

    // Supervisor BEFORE we move (so it stays outside the cgroup it will kill) and before
    // Landlock (so it stays outside the sandbox and can write cgroupfs for us).
    const startTime = startTimeOf("self") ?? "0";
    try {
      launchSupervisor(CGROUP_SUPERVISOR, ownName, `${ownDir} ${process.pid} ${startTime}`, process.env as Record<string, string>);
    } catch (e) {
      removeCgroup(ownDir);
      return { reason: `cannot start /bin/sh supervisor: ${errText(e)}` };
    }
    const sup = supervisor!;
    const abortSetup = () => {
      sup.abort();
      supervisor = undefined;
      supSpec = undefined;
    };

    const moveErr = moveToCgroup(ownDir, process.pid);
    if (moveErr !== undefined) {
      abortSetup();
      removeCgroup(ownDir);
      return { reason: `moving self into ${ownDir} failed (${moveErr})` };
    }
    const nowPath = cgroupPathOf("self");
    const ownPath = `${path === "/" ? "" : path}/${ownName}`;
    if (nowPath !== ownPath) {
      // Should be impossible after a successful write; report it rather than guess. Stop the
      // supervisor explicitly: dropping its handle would let GC close the pipe later and
      // fire cgroup.kill on a cgroup that may contain us.
      abortSetup();
      return { reason: `cgroup.procs write succeeded but /proc/self/cgroup says ${nowPath}, expected ${ownPath}` };
    }

    const notes: string[] = [];
    let adoptedCount = 0;

    // Adopt: everything already below us in the parent chain joins our cgroup, so "spawned
    // before setup" stops mattering. Must happen before Landlock (cgroupfs writes). A
    // descendant that already daemonized out of the parent chain is not found.
    {
      const pre = descendantsOf(process.pid, (pid, st) => isSupervisor(pid, st));
      let adopted = 0;
      let gone = 0;
      const errors = new Map<string, number>();
      for (const pid of pre) {
        const err = moveToCgroup(ownDir, pid);
        if (err === undefined) adopted++;
        else if (err === "ESRCH" || !pidExists(pid)) gone++;
        else errors.set(err, (errors.get(err) ?? 0) + 1);
      }
      adoptedCount = adopted;
      if (errors.size) {
        const why = [...errors].map(([code, n]) => `${n}x ${code}`).join(", ");
        notes.push(`adopted ${adopted} of ${pre.length - gone} pre-existing descendant(s) (${why}); the rest are not in the cgroup`);
      }
    }

    // Sweep dead owners next to us (their supervisor was killed, their tree and directory
    // leaked). Also before Landlock. After the transient-scope route our siblings are other
    // scopes, so sweep the owners inside sibling `bsc-scope-*` scopes too.
    sweepDeadOwners(parentDir, { skip: ownName });
    if (tookScope) {
      const scopesDir = parentDir.slice(0, parentDir.lastIndexOf("/"));
      const ownScope = parentDir.slice(parentDir.lastIndexOf("/") + 1);
      try {
        for (const name of readdirSync(scopesDir)) {
          if (name !== ownScope && /^bsc-scope-.*\.scope$/.test(name)) sweepDeadOwners(`${scopesDir}/${name}`);
        }
      } catch {
        /* not listable */
      }
    }

    // Landlock last: from here on this process cannot write cgroupfs either.
    //
    // `kernel` is claimed only when the sandbox closes BOTH same-UID holes: leaving the
    // cgroup (any Landlock) and signalling the supervisor (ABI 6+ scoping). Otherwise a
    // deliberate descendant can still defeat the cleanup and the accurate word is best-effort.
    let landlocked = false;
    let scopedSignals = false;
    let allThreads = false;
    if (!landlockWanted(options)) {
      notes.push(`${LANDLOCK_ENV}=0: same-UID descendants can leave the cgroup or kill the supervisor`);
    } else {
      const ll = restrictCgroupWrites(root);
      if (typeof ll === "string") {
        notes.push(`landlock unavailable (${ll}); same-UID descendants can leave the cgroup or kill the supervisor`);
      } else {
        landlocked = true;
        scopedSignals = ll.scopedSignals;
        if (!ll.scopedSignals) notes.push(`landlock ABI ${ll.abi} has no signal scoping (needs 6+); descendants can kill the supervisor`);
        allThreads = ll.allThreads;
        if (!ll.allThreads) notes.push("landlock applied to the calling thread only (no TSYNC, needs ABI 8); Workers created before the first spawn, and their children, are not sandboxed");
      }
    }
    // Adopted processes were moved in BEFORE the ruleset (we cannot write cgroupfs after it),
    // so they are outside the Landlock domain: they can leave the cgroup or signal the
    // supervisor, and with signal scoping we cannot signal them (killAll routes through the
    // supervisor for that reason). Same shape as the no-TSYNC Worker note.
    if (landlocked && adoptedCount > 0) {
      notes.push(`${adoptedCount} adopted pre-existing process(es) are outside the Landlock sandbox (it applies only to processes started after setup): they can leave the cgroup or kill the supervisor`);
    }
    // All three, and nothing unsandboxed inside, or it is not a kernel guarantee against a
    // deliberate same-UID descendant.
    const guarantee: Guarantee = landlocked && scopedSignals && allThreads && adoptedCount === 0 ? "kernel" : "best-effort";

    /** cgroupfs writes: direct while we still may, via the (current) supervisor once landlocked. */
    const ops = landlocked
      ? {
          track: (pid: number) => supervisor?.send(`track ${pid}`),
          kill: (pid: number): string | undefined => {
            supervisor?.send(`kill ${pid}`);
            return undefined;
          },
          rmdir: (pid: number) => supervisor?.send(`rmdir ${pid}`),
        }
      : {
          track: (pid: number) => {
            if (parentPid(pid) !== process.pid) return; // pid reused or not ours: never move it
            const dir = `${ownDir}/c-${pid}`;
            if (makeCgroup(dir) !== undefined) return;
            if (moveToCgroup(dir, pid) !== undefined) removeCgroup(dir);
          },
          kill: (pid: number): string | undefined => killCgroup(`${ownDir}/c-${pid}`),
          rmdir: (pid: number) => void removeCgroup(`${ownDir}/c-${pid}`),
        };

    /** Per-spawn child cgroups, keyed by child pid, for killTree. */
    const childGroups = new Map<number, { dir: string; childExited: boolean }>();

    function sweep(): void {
      for (const [pid, entry] of childGroups) {
        if (!entry.childExited) continue;
        const populated = isPopulated(entry.dir);
        if (populated === false || populated === undefined) {
          childGroups.delete(pid);
          if (populated === false) ops.rmdir(pid);
        }
      }
    }

    const supervisorGone = () => {
      const s = supervisor;
      return !s || s.proc.exitCode !== null || s.proc.signalCode !== null;
    };

    const strategy: Strategy = {
      name: landlocked ? BACKEND_CGROUP_LANDLOCK : BACKEND_CGROUP,
      guarantee,
      note: notes.length ? notes.join("; ") : undefined,
      spawnEnv: () => undefined,

      track(proc) {
        const pid = proc.pid;
        if (!pid || childGroups.has(pid)) return;
        try {
          sweep();
          // Grandchildren the child forks before the move stay in ownDir: missed by
          // killTree(child), still killed by killTree() and with the owner.
          ops.track(pid);
          const entry = { dir: `${ownDir}/c-${pid}`, childExited: false };
          childGroups.set(pid, entry);
          const onExit = () => {
            entry.childExited = true;
            sweep();
          };
          proc.exited.then(onExit, onExit);
        } catch {
          /* tracking is an enhancement; the owner cgroup is the guarantee */
        }
      },

      killTree(pid) {
        const entry = childGroups.get(pid);
        if (!entry) return { tracked: false, detail: "pid not tracked by a child cgroup" };
        try {
          if (landlocked) {
            // The move is asynchronous via the supervisor: wait (200 ms max) until the child
            // is actually IN the per-spawn cgroup, not merely until the directory exists
            // (mkdir precedes the cgroup.procs write and that write can fail). If it never
            // lands, say so and let the caller fall back to a plain kill.
            const landed = () =>
              (readCgroupFile(entry.dir, "cgroup.procs") ?? "").split("\n").includes(String(pid)) ||
              isPopulated(entry.dir) === true;
            let ok = landed();
            for (let i = 0; !ok && i < 100 && !supervisorGone(); i++) {
              Bun.sleepSync(2);
              ok = landed();
            }
            if (!ok) {
              return {
                tracked: false,
                detail: supervisorGone()
                  ? "supervisor is gone; per-spawn cgroup was never populated"
                  : `per-spawn cgroup ${entry.dir} never received the child (it exited first, or the supervisor cannot create cgroups)`,
              };
            }
          } else if (!existsSync(entry.dir)) {
            return { tracked: false, detail: `per-spawn cgroup ${entry.dir} does not exist` };
          }
          const err = ops.kill(pid);
          if (err !== undefined) return { tracked: false, detail: `cgroup.kill failed (${err})` };
          if (landlocked) {
            // The kill is queued behind the pipe: confirm it emptied the cgroup (300 ms max).
            let empty = isPopulated(entry.dir) !== true;
            for (let i = 0; !empty && i < 150; i++) {
              Bun.sleepSync(2);
              empty = isPopulated(entry.dir) !== true;
            }
            if (!empty) {
              if (supervisorGone()) return { tracked: false, detail: "supervisor is gone; cgroup.kill was never applied" };
              return { tracked: true, detail: `cgroup.kill queued via supervisor on ${entry.dir}; not yet empty after 300 ms` };
            }
            return { tracked: true, detail: `cgroup.kill via supervisor on ${entry.dir}, confirmed empty` };
          }
          return { tracked: true, detail: `cgroup.kill on ${entry.dir}` };
        } catch (e) {
          return { tracked: false, detail: `cgroup.kill failed: ${errText(e)}` };
        } finally {
          sweep();
        }
      },

      killAll() {
        // Everything listed in our cgroup tree's cgroup.procs except us and our supervisors.
        // Without Landlock we can do it all: cgroup.kill on every per-spawn cgroup, then
        // SIGKILL passes over the remaining members (a process forked meanwhile is born inside
        // the cgroup, so the next pass sees it). With Landlock the supervisor (outside the
        // sandbox) does the cgroup.kill writes and SIGKILLs the direct members, because
        // adopted processes are outside our Landlock domain and signal scoping makes our own
        // SIGKILL fail with EPERM for them; we still run our own passes for the rest. Anything
        // left after the passes is reported: `tracked: false` with the survivor count.
        const others = () => cgroupMembers(ownDir).filter((p) => p !== process.pid && !isSupervisor(p));
        const signalled = new Set<number>();
        let eperm = 0;
        try {
          if (landlocked) supervisor?.send("killall 0");
          else {
            try {
              for (const name of readdirSync(ownDir)) if (name.startsWith("c-")) killCgroup(`${ownDir}/${name}`);
            } catch {
              /* fall through to the signal passes */
            }
          }
          let left = others();
          for (let round = 0; round < 50 && left.length; round++) {
            eperm = 0;
            for (const p of left) {
              signalled.add(p);
              try {
                process.kill(p, "SIGKILL");
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "EPERM") eperm++;
              }
            }
            if (landlocked && round === 25) supervisor?.send("killall 0"); // late forks of unsandboxed members
            Bun.sleepSync(4);
            left = others();
          }
          if (left.length) {
            return {
              tracked: false,
              detail: `${left.length} process(es) still in ${ownDir} after 50 kill passes (${eperm} refused with EPERM${landlocked && supervisorGone() ? "; supervisor is gone" : ""}): ${left.slice(0, 10).join(" ")}`,
            };
          }
          return { tracked: true, detail: `killed ${signalled.size} process(es) in ${ownDir} (owner and supervisor excluded)` };
        } catch (e) {
          return { tracked: false, detail: `killAll failed: ${errText(e)}` };
        } finally {
          sweep();
        }
      },

      isContained(pid) {
        const p = cgroupPathOf(pid);
        if (p === undefined) return undefined;
        return p === ownPath || p.startsWith(`${ownPath}/`);
      },

      onRestart(next) {
        if (landlocked) {
          // Born inside our cgroup and our Landlock domain, and neither can be left: it cannot
          // write cgroupfs, so it falls back to signal sweeps (see CGROUP_SUPERVISOR). Any
          // poller of the old supervisor that survived is outside both and still runs a full
          // cgroup.kill at owner death, so it is left alone.
          return {
            guarantee: "best-effort",
            note: "supervisor restarted inside the Landlock sandbox: owner-death cleanup is a SIGKILL sweep of cgroup.procs instead of cgroup.kill, new spawns get no per-spawn cgroup, and the cgroup directory is left for the next sweep",
            abortOld: false,
          };
        }
        // Not sandboxed: move it (and, a moment later, anything it forked before the move)
        // back out to where the first supervisor lives, so cgroup.kill does not kill it.
        const err = moveToCgroup(parentDir, next.pid);
        setTimeout(() => {
          for (const p of cgroupMembers(ownDir)) if (procStat(p)?.sid === next.pid) moveToCgroup(parentDir, p);
        }, 50).unref();
        return err === undefined
          ? { abortOld: false }
          : { note: `restarted supervisor could not leave the owner cgroup (${err}); its cgroup.kill also kills itself, so the directory is left for the next sweep`, abortOld: false };
      },
    };
    return { strategy };
  }

  // -------------------------------------------------------------------------------------
  // best-effort: child subreaper + supervisor snapshots (+ env marker as the second net)
  // -------------------------------------------------------------------------------------

  function setupMarker(): { strategy: Strategy } | { reason: string } {
    if (!existsSync("/proc/self/stat")) return { reason: "/proc is not mounted" };
    const subreaperErr = becomeSubreaper();
    const id = `${process.pid}-${randomBytes(6).toString("hex")}`;
    // Nest under an outer owner's marker, if any, so the outer supervisor still matches us
    // and ours. The supervisor itself must NOT carry the marker: pass it a clean env.
    const inherited = process.env[MARKER_ENV];
    const markerValue = inherited ? `${inherited}:${id}` : id;
    const cleanEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    delete cleanEnv[MARKER_ENV];
    const startTime = startTimeOf("self") ?? "0";
    try {
      launchSupervisor(MARKER_SUPERVISOR, `bsc-${id}`, `${MARKER_ENV} ${id} ${process.pid} ${startTime}`, cleanEnv);
    } catch (e) {
      return { reason: `cannot start /bin/sh supervisor: ${errText(e)}` };
    }
    // Stamp our own process.env so callers who build `env: { ...process.env, ... }` pass the
    // marker through (the supervisor's second net). Bun.spawn's DEFAULT env is a startup
    // snapshot and ignores this, which no longer matters: the subreaper is the mechanism.
    process.env[MARKER_ENV] = markerValue;
    const extraEnv = { [MARKER_ENV]: markerValue };
    const prune = (pid: number, st: ProcStat) => isSupervisor(pid, st);

    // Adopt: nothing to move, the existing descendants are already under us in the parent
    // chain; the supervisor's first snapshot (within a second) records them. Direct children
    // are registered at once, as library spawns are.
    for (const pid of descendantsOf(process.pid, prune)) if (parentPid(pid) === process.pid) supervisor?.send(`track ${pid}`);

    /** Library spawns: pid -> its start time and a snapshot of every descendant seen (pid -> start). */
    const tracked = new Map<number, { start: string | undefined; snap: Map<number, string>; exited: boolean }>();

    function refresh(table: Map<number, ProcStat> = procTable()): void {
      for (const [pid, entry] of tracked) {
        for (const [p, start] of entry.snap) if (table.get(p)?.start !== start) entry.snap.delete(p);
        if (!entry.exited && table.get(pid)?.start === entry.start) {
          for (const d of descendantsOf(pid, prune, table)) entry.snap.set(d, table.get(d)!.start);
        }
        if (entry.exited && entry.snap.size === 0) tracked.delete(pid);
      }
    }

    /**
     * Register every new DIRECT child with the supervisor at once. Under the subreaper every
     * orphan in our tree becomes a direct child, and direct children are exactly what
     * reparents away (to init) the moment we die, so the supervisor must know them before
     * that; its own 1 s snapshot is the backstop. `track` lines already in the pipe are still
     * read after our death. Source: /proc/self/task/<tid>/children (CONFIG_PROC_CHILDREN),
     * else the ppid column of a full /proc pass every 250 ms.
     */
    const registered = new Map<number, string>();
    let childrenFile = true;
    function registerDirectChildren(kids: number[]): void {
      const now = new Set(kids);
      for (const p of registered.keys()) if (!now.has(p)) registered.delete(p);
      for (const p of kids) {
        if (registered.has(p) || supervisorSids.has(p)) continue;
        const st = procStat(p);
        if (!st || st.ppid !== process.pid || isSupervisor(p, st)) continue;
        registered.set(p, st.start);
        supervisor?.send(`track ${p}`);
      }
    }
    function directChildrenFromTask(): number[] | undefined {
      try {
        const kids: number[] = [];
        for (const t of readdirSync("/proc/self/task")) {
          for (const w of readFileSync(`/proc/self/task/${t}/children`, "latin1").split(" ")) if (w.trim()) kids.push(Number(w));
        }
        return kids;
      } catch {
        return undefined;
      }
    }

    // One unref'd 50 ms timer: direct-child registration (every tick), per-spawn snapshot
    // refresh (every 250 ms, only while something is tracked), adopted-zombie reaping (every
    // second, only when we are a subreaper). Cost: a handful of small /proc reads per tick,
    // plus one full /proc pass every 250 ms while library spawns are tracked.
    let ticks = 0;
    const timer = setInterval(() => {
      try {
        ticks++;
        if (childrenFile) {
          const kids = directChildrenFromTask();
          if (kids) registerDirectChildren(kids);
          else childrenFile = false;
        }
        if (ticks % 5 === 0 && (tracked.size || !childrenFile)) {
          const table = procTable();
          if (tracked.size) refresh(table);
          if (!childrenFile) registerDirectChildren([...table].filter(([, st]) => st.ppid === process.pid).map(([p]) => p));
        }
        if (!subreaperErr && ticks % 20 === 0) reapAdoptedZombies(new Set(tracked.keys()));
      } catch {
        /* never let the timer throw */
      }
    }, 50);
    timer.unref();

    /** Descendants (live parent chain) of any pid in `known`, from one /proc pass. */
    const expand = (known: Set<number>): number[] => {
      const table = procTable();
      const out: number[] = [];
      for (const k of known) out.push(...descendantsOf(k, prune, table));
      return out;
    };

    const notes: string[] = [];
    if (subreaperErr) notes.push(`${subreaperErr}: orphans reparent to init, so only processes carrying the ${MARKER_ENV} env marker (injected into spawn()) are reaped`);

    const strategy: Strategy = {
      name: BACKEND_MARKER,
      guarantee: "best-effort",
      note: notes.length ? notes.join("; ") : undefined,
      // Byte-for-byte Bun.spawn, unless the subreaper failed and the marker is all we have.
      spawnEnv: () => (subreaperErr ? extraEnv : undefined),

      track(proc) {
        const pid = proc.pid;
        if (!pid) return;
        supervisor?.send(`track ${pid}`);
        const entry = { start: startTimeOf(pid), snap: new Map<number, string>(), exited: false };
        if (entry.start !== undefined) registered.set(pid, entry.start);
        tracked.set(pid, entry);
        const onExit = () => {
          entry.exited = true;
        };
        proc.exited.then(onExit, onExit);
        refresh();
      },

      killTree(pid) {
        const entry = tracked.get(pid);
        if (!entry) return { tracked: false, detail: "pid not tracked" };
        const table = procTable();
        refresh(table);
        const seeds: number[] = [...entry.snap.keys()];
        if (entry.start !== undefined && table.get(pid)?.start === entry.start) seeds.unshift(pid);
        const killed = stopAndKill(seeds, expand);
        entry.snap.clear();
        if (entry.exited) tracked.delete(pid);
        return { tracked: true, detail: `SIGKILL ${killed.length} process(es) via ppid walk + per-spawn snapshot` };
      },

      killAll() {
        const killed = stopAndKill(descendantsOf(process.pid, prune), (known) => [...expand(known), ...descendantsOf(process.pid, prune)]);
        for (const entry of tracked.values()) entry.snap.clear();
        return { tracked: true, detail: `SIGKILL ${killed.length} process(es) via ppid walk from the owner (supervisor excluded)` };
      },

      isContained(pid) {
        // Under the subreaper every descendant's parent chain leads to us; the marker is the
        // second net (and the only one when the prctl failed).
        let p: number | undefined = pid;
        for (let i = 0; p !== undefined && p > 1 && i < 4096; i++) {
          const st = procStat(p);
          if (!st) return i === 0 ? undefined : false;
          if (isSupervisor(p, st)) return false;
          if (st.ppid === process.pid) return true;
          p = st.ppid;
        }
        return environHasMarker(pid, MARKER_ENV, id) ?? false;
      },

      onRestart() {
        // The old poller would snapshot the new supervisor as one of our descendants and kill
        // it at owner death; replace the whole old session.
        return { abortOld: true };
      },
    };
    return { strategy };
  }

  // -------------------------------------------------------------------------------------

  function ensure(options?: CleanupOptions): CleanupStatus {
    if (memo) return memo;
    memo = (() => {
      if (!IS_LINUX) return fail("linux", "none", "not linux");
      const disabled = disabledBy(options);
      if (disabled) return fail("linux", "none", disabled);
      const want = requestedMechanism(options);
      try {
        let cgroupReason: string | undefined;
        if (want !== "best-effort") {
          const r = setupCgroup(options);
          if ("nested" in r) {
            // The outer owner IS the cgroup mechanism, so this is not a failure even when
            // `cgroup` was pinned (the env var is inherited by nested owners).
            cgroupReason = r.nested;
          } else if ("strategy" in r) {
            strategy = r.strategy;
            const status: CleanupStatus = { platform: "linux", backend: r.strategy.name, guarantee: r.strategy.guarantee, active: true };
            if (r.strategy.note) status.reason = r.strategy.note;
            return status;
          } else {
            cgroupReason = r.reason;
            if (want === "cgroup") return fail(BACKEND_CGROUP, "kernel", `cgroup v2 unavailable: ${cgroupReason}`);
          }
        }
        const m = setupMarker();
        if ("strategy" in m) {
          strategy = m.strategy;
          const status: CleanupStatus = { platform: "linux", backend: BACKEND_MARKER, guarantee: "best-effort", active: true };
          const reasons: string[] = [];
          if (cgroupReason) reasons.push(`${cgroupReason.startsWith("nested") ? cgroupReason : `cgroup v2 unavailable (${cgroupReason})`}; using subreaper + /proc snapshots`);
          if (m.strategy.note) reasons.push(m.strategy.note);
          if (reasons.length) status.reason = reasons.join("; ");
          return status;
        }
        return fail(BACKEND_MARKER, "best-effort", m.reason);
      } catch (err) {
        return fail("linux", "none", `setup threw: ${errText(err)}`);
      }
    })();
    base = memo;
    if (memo.active && supervisor) watchSupervisor(supervisor);
    return memo;
  }

  /** Exit times of supervisors that died while we were alive, for the restart budget. */
  let exits: number[] = [];
  let restarts = 0;

  /**
   * The supervisor should outlive us. If it exits while we are alive (a same-user `pkill -f
   * bsc-supervisor`, an OOM kill), start a replacement exactly as setup did, re-arm, and keep
   * the per-spawn tracking (the strategies reach the supervisor through `supervisor`, which
   * now points at the new one). `RESTART_LIMIT` restarts per `RESTART_WINDOW_MS`; the next
   * exit inside the window gives up: `active: false`, the one case where a memoized status
   * stops being active, and killTree stops pretending it can reach anything.
   */
  function watchSupervisor(sup: Supervisor): void {
    const onExit = (code: unknown) => {
      if (supervisor !== sup || !memo?.active || !base || !strategy) return;
      const how = sup.proc.signalCode ?? code;
      const now = Date.now();
      exits = exits.filter((t) => now - t < RESTART_WINDOW_MS);
      exits.push(now);
      const giveUp = (why: string) => {
        memo = {
          ...memo!,
          active: false,
          reason: `supervisor exited (${String(how)}) while the owner is alive; ${why}; per-spawn tracking is gone, and owner-death cleanup now depends on its liveness poller alone, if that survived`,
        };
        strategy = undefined;
      };
      if (exits.length > RESTART_LIMIT) return giveUp(`it was restarted ${RESTART_LIMIT} times within ${RESTART_WINDOW_MS / 1000} s, giving up`);
      if (!supSpec) return giveUp("no restart recipe");
      let next: Supervisor;
      try {
        next = launchSupervisor(supSpec.script, supSpec.token, supSpec.config, supSpec.env);
      } catch (e) {
        return giveUp(`restart failed: ${errText(e)}`);
      }
      let fix: RestartFixup = {};
      try {
        fix = strategy.onRestart(next);
      } catch {
        /* keep the restart */
      }
      if (fix.abortOld) sup.abort();
      restarts++;
      const reason = [base.reason, `supervisor restarted ${restarts} time(s) after it exited (${String(how)})`, fix.note].filter(Boolean).join("; ");
      memo = { ...base, guarantee: fix.guarantee ?? memo.guarantee, active: true, reason };
      watchSupervisor(next);
    };
    sup.proc.exited.then(onExit, onExit);
  }

  const active = (): Strategy | undefined => (ensure().active ? strategy : undefined);

  return {
    platform: "linux",
    get name() {
      return memo?.backend ?? "linux";
    },
    get guarantee() {
      return memo?.guarantee ?? "none";
    },
    ensure,
    status: () => memo ?? fail("linux", "none", "not configured; configureSpawnCleanup() has not run"),
    track: (proc) => {
      try {
        active()?.track(proc);
      } catch {
        /* never throw from track */
      }
    },
    killTree: (pid) => {
      const s = active();
      if (!s) return { tracked: false, detail: ensure().reason ?? "backend inactive" };
      try {
        return s.killTree(pid);
      } catch (e) {
        return { tracked: false, detail: `killTree threw: ${errText(e)}` };
      }
    },
    killAll: () => {
      const s = active();
      if (!s) return { tracked: false, detail: ensure().reason ?? "backend inactive" };
      try {
        return s.killAll();
      } catch (e) {
        return { tracked: false, detail: `killAll threw: ${errText(e)}` };
      }
    },
    isContained: (pid) => {
      const s = active();
      if (!s) return undefined;
      try {
        return s.isContained(pid);
      } catch {
        return undefined;
      }
    },
    spawnEnv: () => active()?.spawnEnv(),
  };
}
