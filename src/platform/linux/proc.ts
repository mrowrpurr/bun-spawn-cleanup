/**
 * Small /proc readers shared by the Linux backend. Everything here is synchronous, never
 * throws, and returns `undefined` when the process is gone or unreadable.
 */
import { readdirSync, readFileSync } from "node:fs";

/** The /proc/<pid>/stat fields the backend uses. */
export interface ProcStat {
  /** State letter: R, S, D, T, Z, X, ... */
  state: string;
  ppid: number;
  pgrp: number;
  /** Session id. A supervisor is spawned `detached` (setsid), so its whole session is it. */
  sid: number;
  /** Start time in clock ticks since boot (field 22), as a string: compared, never added. */
  start: string;
}

/** Parse /proc/<pid>/stat, or undefined when the process is gone or unreadable. */
export function procStat(pid: number | "self"): ProcStat | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "latin1");
    // "<pid> (<comm>) <state> <ppid> <pgrp> <session> ..." — comm may contain spaces and
    // parens, so split after the LAST ")".
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(rest[1]);
    const pgrp = Number(rest[2]);
    const sid = Number(rest[3]);
    if (!Number.isFinite(ppid) || rest[19] === undefined) return undefined;
    return { state: rest[0] ?? "?", ppid, pgrp, sid, start: rest[19] };
  } catch {
    return undefined;
  }
}

/** Parent pid of `pid` from /proc/<pid>/stat, or undefined. */
export function parentPid(pid: number): number | undefined {
  return procStat(pid)?.ppid;
}

/** Process start time (clock ticks since boot, /proc/<pid>/stat field 22) as a string. */
export function startTimeOf(pid: number | "self"): string | undefined {
  return procStat(pid)?.start;
}

/** Every numeric entry of /proc, i.e. every visible pid. */
export function allPids(): number[] {
  try {
    return readdirSync("/proc")
      .filter((n) => /^\d+$/.test(n))
      .map(Number);
  } catch {
    return [];
  }
}

/** One pass over /proc: pid -> stat, for every visible process. */
export function procTable(): Map<number, ProcStat> {
  const out = new Map<number, ProcStat>();
  for (const pid of allPids()) {
    const st = procStat(pid);
    if (st) out.set(pid, st);
  }
  return out;
}

/**
 * Transitive descendants of `root` via the ppid chain, from one pass over /proc (or the
 * given table). `prune(pid, stat)` returning true excludes that pid AND its subtree, which
 * is how callers keep a supervisor (a child of the owner) and its helpers out of the set.
 * Processes whose intermediate parent already exited (and so were reparented to init, or
 * to a subreaper) are NOT found under `root`: the documented limit of a parent-chain walk.
 */
export function descendantsOf(
  root: number,
  prune?: (pid: number, st: ProcStat) => boolean,
  table: Map<number, ProcStat> = procTable(),
): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, st] of table) {
    const list = children.get(st.ppid);
    if (list) list.push(pid);
    else children.set(st.ppid, [pid]);
  }
  const out: number[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length) {
    const p = queue.shift()!;
    for (const c of children.get(p) ?? []) {
      if (seen.has(c)) continue;
      seen.add(c);
      if (prune?.(c, table.get(c)!)) continue;
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

/**
 * Freeze-then-kill: SIGSTOP every pid in `seeds`, then repeatedly SIGSTOP whatever
 * `expand()` returns that is not stopped yet (children forked before the stop landed are
 * still linked to their stopped parent, so a ppid walk sees them), until a pass finds
 * nothing new or `maxRounds` passes; then SIGKILL the whole set. Stopping first is what makes
 * a ppid walk race-free against forking: a stopped process cannot fork, and its children
 * cannot reparent away from it while it is alive. Never throws. Returns the pids signalled.
 */
export function stopAndKill(seeds: Iterable<number>, expand: (known: Set<number>) => Iterable<number>, maxRounds = 20): number[] {
  const known = new Set<number>();
  const stop = (pids: Iterable<number>): boolean => {
    let added = false;
    for (const p of pids) {
      if (known.has(p) || p <= 1 || p === process.pid) continue;
      known.add(p);
      added = true;
      try {
        process.kill(p, "SIGSTOP");
      } catch {
        /* gone */
      }
    }
    return added;
  };
  try {
    stop(seeds);
    for (let i = 0; i < maxRounds; i++) {
      if (!stop(expand(known))) break;
    }
  } catch {
    /* fall through to the kill with what we have */
  }
  for (const p of known) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* gone */
    }
  }
  return [...known];
}

/**
 * Does /proc/<pid>/environ carry `NAME=...<id>...`? Reads the environment the process was
 * exec'd with (the kernel-visible one). `undefined` when unreadable: process gone, or owned
 * by another user (environ is readable only with ptrace access, in practice same uid).
 */
export function environHasMarker(pid: number, name: string, id: string): boolean | undefined {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "latin1");
    const prefix = `${name}=`;
    for (const entry of env.split("\0")) {
      if (entry.startsWith(prefix) && entry.includes(id)) return true;
    }
    return false;
  } catch {
    return undefined;
  }
}

/** Current cgroup v2 path of `pid` (the part after `0::`), or undefined. */
export function cgroupPathOf(pid: number | "self"): string | undefined {
  try {
    const text = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    for (const line of text.split("\n")) {
      if (line.startsWith("0::")) return line.slice(3).trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** kill(pid, 0): is the pid alive (or at least present)? */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
