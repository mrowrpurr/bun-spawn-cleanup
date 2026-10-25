/**
 * Dead-owner sweep for the Linux backend, shared by setup (`ensure()`) and the CLI.
 *
 * An owner's cgroup is `bsc-<pid>-<6 hex>` under the cgroup the owner started in (or under a
 * transient `bsc-scope-*.scope`). Normally its supervisor writes `cgroup.kill` and removes
 * the directory when the owner dies. If the supervisor was killed too (a same-user `pkill -f
 * bsc-supervisor`, an OOM kill of the session), the tree keeps running and the directory is
 * orphaned. Every owner's setup sweeps its siblings, and `bun-spawn-cleanup sweep` sweeps
 * the whole cgroup2 mount, the same job the macOS ledger sweep does at first spawn.
 *
 * "Dead" is decided without any file of our own (cgroupfs allows only its control files):
 * the `<pid>` in the name does not exist, is a zombie, or started measurably AFTER the
 * directory was created, i.e. the pid was recycled. The comparison is directory ctime/mtime
 * (kernfs: creation or a later inode instantiation, never earlier) against the process start
 * time (boot time + ticks / USER_HZ). Every inaccuracy in it errs towards "alive", so a live
 * owner is never swept; a recycled pid is only missed when its new process started within a
 * few seconds of the dead owner's directory.
 *
 * Also the best-effort counterpart for the CLI: processes that carry `BUN_SPAWN_CLEANUP_ID`
 * whose outermost owner pid is gone.
 */
import { readdirSync, readFileSync, rmdirSync, statSync, type Dirent } from "node:fs";
import { isPopulated, killCgroup, readCgroupFile } from "./cgroup.ts";
import { allPids, pidExists, procStat } from "./proc.ts";

/**
 * Name of the cgroup an owner creates: `bsc-<pid>-<6 hex>`. Anchored so the transient scope
 * segment `bsc-scope-<suffix>.scope` never matches. Used to recognise an outer owner.
 */
export const OWN_CGROUP_RE = /^bsc-(\d+)-[0-9a-f]{6}$/;

/** Inherited marker in best-effort mode. Colon-separated when owners nest. */
export const MARKER_ENV = "BUN_SPAWN_CLEANUP_ID";

/** USER_HZ: 100 on every mainstream Linux architecture (the /proc tick unit, not CONFIG_HZ). */
const USER_HZ = 100;
/** Slack for btime's whole-second resolution plus scheduling between start and mkdir. */
const START_SLACK_MS = 3_000;

let bootMs: number | undefined;
function bootTimeMs(): number | undefined {
  if (bootMs !== undefined) return bootMs;
  try {
    const m = /^btime (\d+)$/m.exec(readFileSync("/proc/stat", "latin1"));
    if (m) bootMs = Number(m[1]) * 1000;
  } catch {
    /* unknown */
  }
  return bootMs;
}

/** Owner pid from a `bsc-<pid>-<hex>` directory name, else undefined. */
export function ownerPidOf(name: string): number | undefined {
  const m = OWN_CGROUP_RE.exec(name);
  return m ? Number(m[1]) : undefined;
}

/**
 * Is the owner of cgroup `dir` (named `bsc-<pid>-<hex>`) still alive? Errs towards true:
 * when anything is unreadable the answer is "alive", so a sweep never kills a live tree.
 */
export function ownerAlive(dir: string, pid: number): boolean {
  const st = procStat(pid);
  if (!st) return pidExists(pid); // EPERM: exists but unreadable, assume alive
  if (st.state === "Z" || st.state === "X") return false;
  const boot = bootTimeMs();
  let dirMs: number;
  try {
    const s = statSync(dir);
    dirMs = Math.max(s.ctimeMs, s.mtimeMs);
  } catch {
    return true;
  }
  if (boot === undefined || !(dirMs > boot)) return true; // timestamps unusable
  const startMs = boot + (Number(st.start) * 1000) / USER_HZ;
  return startMs <= dirMs + START_SLACK_MS;
}

/** `dir` and every sub-directory of it, deepest first. */
function cgroupTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      /* gone */
    }
    for (const e of entries) if (e.isDirectory()) walk(`${d}/${e.name}`);
    out.push(d);
  };
  walk(dir);
  return out;
}

/** Every pid in `dir` and its sub-cgroups (from each `cgroup.procs`). */
export function cgroupMembers(dir: string): number[] {
  const out = new Set<number>();
  for (const d of cgroupTree(dir)) {
    for (const line of (readCgroupFile(d, "cgroup.procs") ?? "").split("\n")) {
      const n = Number(line);
      if (line && Number.isInteger(n) && n > 0) out.add(n);
    }
  }
  return [...out];
}

export interface SweptOwner {
  /** The `bsc-<pid>-<hex>` directory. */
  dir: string;
  ownerPid: number;
  /** Pids that were members when the sweep started (all SIGKILLed by `cgroup.kill`). */
  killed: number[];
  /** The directory (and its `c-*` children) is gone. */
  removed: boolean;
  /** Why the kill or the removal failed, if it did. */
  error?: string;
}

/**
 * Kill everything in `dir` (`cgroup.kill`, falling back to SIGKILL of each member when the
 * write is refused), wait up to `waitMs` for `populated 0`, then rmdir the tree deepest
 * first. Never throws.
 */
export function killAndRemove(dir: string, ownerPid: number, waitMs = 1_000): SweptOwner {
  const killed = cgroupMembers(dir);
  const errors: string[] = [];
  const err = killCgroup(dir);
  if (err !== undefined) {
    errors.push(`cgroup.kill: ${err}`);
    for (const p of killed) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        /* gone or not ours */
      }
    }
  }
  const deadline = Date.now() + waitMs;
  while (isPopulated(dir) === true && Date.now() < deadline) Bun.sleepSync(10);
  let removed = true;
  for (const d of cgroupTree(dir)) {
    try {
      rmdirSync(d);
    } catch (e) {
      removed = false;
      errors.push(`rmdir ${d}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
      break;
    }
  }
  const out: SweptOwner = { dir, ownerPid, killed, removed };
  if (errors.length) out.error = errors.join("; ");
  return out;
}

/**
 * Sweep the `bsc-<pid>-<hex>` children of `parentDir` whose owner is dead. `skip` is a
 * directory name to leave alone (the caller's own). Returns what was swept. Never throws.
 */
export function sweepDeadOwners(parentDir: string, opts: { skip?: string; waitMs?: number } = {}): SweptOwner[] {
  const out: SweptOwner[] = [];
  let names: string[];
  try {
    names = readdirSync(parentDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === opts.skip) continue;
    const pid = ownerPidOf(name);
    if (pid === undefined) continue;
    const dir = `${parentDir}/${name}`;
    try {
      if (ownerAlive(dir, pid)) continue;
      out.push(killAndRemove(dir, pid, opts.waitMs));
    } catch {
      /* never let a sweep break setup */
    }
  }
  return out;
}

/**
 * Every owner cgroup under the cgroup2 `root`, wherever it lives (session scopes, user
 * services, transient `bsc-scope-*.scope` units). Does not descend into an owner's own
 * `c-*` children. Unreadable directories are skipped.
 */
export function findOwnerCgroups(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 32) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = `${d}/${e.name}`;
      if (OWN_CGROUP_RE.test(e.name)) out.push(sub);
      else walk(sub, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Sweep every dead owner anywhere under `root` (the CLI's `sweep`). */
export function sweepAllDeadOwners(root: string, waitMs?: number): SweptOwner[] {
  const out: SweptOwner[] = [];
  for (const dir of findOwnerCgroups(root)) {
    const pid = ownerPidOf(dir.slice(dir.lastIndexOf("/") + 1))!;
    try {
      if (!ownerAlive(dir, pid)) out.push(killAndRemove(dir, pid, waitMs));
    } catch {
      /* next */
    }
  }
  return out;
}

export interface MarkedProcess {
  pid: number;
  /** The full marker value, `<pid>-<hex>[:<pid>-<hex>...]`, outermost owner first. */
  value: string;
  /** Outermost owner pid (first segment, before its `-`). */
  ownerPid: number;
}

/** Every readable process carrying `BUN_SPAWN_CLEANUP_ID` (best-effort owners' trees). */
export function markedProcesses(): MarkedProcess[] {
  const out: MarkedProcess[] = [];
  const prefix = `${MARKER_ENV}=`;
  for (const pid of allPids()) {
    if (pid === process.pid) continue;
    let env: string;
    try {
      env = readFileSync(`/proc/${pid}/environ`, "latin1");
    } catch {
      continue;
    }
    const entry = env.split("\0").find((e) => e.startsWith(prefix));
    if (!entry) continue;
    const value = entry.slice(prefix.length);
    const ownerPid = Number(value.split(":")[0]!.split("-")[0]);
    if (Number.isInteger(ownerPid) && ownerPid > 0) out.push({ pid, value, ownerPid });
  }
  return out;
}

/**
 * SIGKILL every marked process whose outermost owner pid is gone (or a zombie). Never kills
 * this process or one of its ancestors (the CLI may itself run inside such a tree). Returns
 * the killed pids grouped by outermost marker segment.
 */
export function sweepDeadMarkers(): Map<string, number[]> {
  const ancestors = new Set<number>();
  for (let p: number | undefined = process.pid, i = 0; p !== undefined && p > 1 && i < 4096; i++) {
    ancestors.add(p);
    p = procStat(p)?.ppid;
  }
  const out = new Map<string, number[]>();
  for (const m of markedProcesses()) {
    if (ancestors.has(m.pid)) continue;
    const st = procStat(m.ownerPid);
    const ownerGone = st ? st.state === "Z" || st.state === "X" : !pidExists(m.ownerPid);
    if (!ownerGone) continue;
    try {
      process.kill(m.pid, "SIGKILL");
    } catch {
      continue;
    }
    const key = m.value.split(":")[0]!;
    out.set(key, [...(out.get(key) ?? []), m.pid]);
  }
  return out;
}
