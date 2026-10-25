/**
 * `PR_SET_CHILD_SUBREAPER` for the best-effort Linux mechanism, plus the zombie reaping it
 * makes necessary. Lazy `bun:ffi`; importing this module does nothing off-Linux.
 *
 * With the flag set (kernel 3.4+, no privilege), a descendant whose parent exits is
 * reparented to THIS process instead of init, so the owner's whole tree stays reachable
 * through /proc/<pid>/stat parent links whatever API created it and however it
 * double-forked. That is what makes the best-effort mechanism process-wide: the supervisor
 * walks parent links from the owner instead of relying on an env marker that only the
 * library's own `spawn()` injected.
 *
 * The cost: those adopted orphans become OUR children, so when they exit they stay zombies
 * until we wait for them. Bun waits only for the processes it spawned itself (per pid, via
 * pidfd where available), never `waitpid(-1)`, so nobody else reaps them. `reapAdoptedZombies`
 * does, and it must never reap one of Bun's own children (Bun's `exited` promise would then
 * never see the status): a zombie is reaped only when no pidfd in this process refers to it
 * (Bun holds one per child it is waiting for) AND it has been a zombie for at least
 * `minAgeMs` (Bun reaps its own within milliseconds of SIGCHLD; the age guard covers a Bun
 * build or kernel without pidfds and a briefly blocked event loop).
 */
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { procTable } from "./proc.ts";

const PR_SET_CHILD_SUBREAPER = 36;
const PR_GET_CHILD_SUBREAPER = 37;
const WNOHANG = 1;

interface Libc {
  prctl(option: number, a: bigint, b: bigint, c: bigint, d: bigint): number;
  waitpid(pid: number, status: Uint8Array | null, options: number): number;
  errno(): number;
  ptr: (view: ArrayBufferView) => number;
}

let libc: Libc | undefined;
let libcError: string | undefined;

/** dlopen libc: glibc's soname first, then the generic linker name (musl ships `libc.so`). */
function loadLibc(): Libc | undefined {
  if (libc || libcError) return libc;
  try {
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { dlopen, FFIType, ptr, read } = ffi;
    const defs = {
      prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
      waitpid: { args: [FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      __errno_location: { args: [], returns: FFIType.ptr },
    } as const;
    let lib: { symbols: unknown } | undefined;
    const errors: string[] = [];
    for (const name of ["libc.so.6", "libc.so"]) {
      try {
        lib = dlopen(name, defs);
        break;
      } catch (e) {
        errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!lib) {
      libcError = `dlopen libc failed (${errors.join("; ")})`;
      return undefined;
    }
    const s = lib.symbols as unknown as {
      prctl: Libc["prctl"];
      waitpid(pid: number, status: number | null, options: number): number;
      __errno_location(): number | bigint;
    };
    const toPtr = ptr as unknown as (view: ArrayBufferView) => number;
    libc = {
      prctl: s.prctl,
      waitpid: (pid, status, options) => s.waitpid(pid, status ? toPtr(status) : null, options),
      errno: () => read.i32(Number(s.__errno_location()), 0),
      ptr: toPtr,
    };
    return libc;
  } catch (e) {
    libcError = `ffi: ${e instanceof Error ? e.message : String(e)}`;
    return undefined;
  }
}

/**
 * Make this process a child subreaper. Returns undefined on success, else a reason string.
 * The flag is per process (not per thread) and survives nothing: it is not inherited by
 * children and is cleared on exec. Never throws.
 */
export function becomeSubreaper(): string | undefined {
  const l = loadLibc();
  if (!l) return libcError ?? "libc unavailable";
  try {
    const r = l.prctl(PR_SET_CHILD_SUBREAPER, 1n, 0n, 0n, 0n);
    if (r !== 0) return `prctl(PR_SET_CHILD_SUBREAPER) failed (errno ${l.errno()})`;
    // Read it back: a seccomp filter returning 0 without acting would otherwise go unnoticed.
    const out = new Uint8Array(4);
    const g = l.prctl(PR_GET_CHILD_SUBREAPER, BigInt(l.ptr(out)), 0n, 0n, 0n);
    if (g === 0 && new DataView(out.buffer).getInt32(0, true) !== 1) return "prctl(PR_SET_CHILD_SUBREAPER) returned 0 but the flag reads back unset";
    return undefined;
  } catch (e) {
    return `prctl: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Pids this process holds a pidfd for (from /proc/self/fdinfo `Pid:` lines). */
function pidfdTargets(): Set<number> {
  const out = new Set<number>();
  let fds: string[];
  try {
    fds = readdirSync("/proc/self/fd");
  } catch {
    return out;
  }
  for (const fd of fds) {
    try {
      if (readlinkSync(`/proc/self/fd/${fd}`) !== "anon_inode:[pidfd]") continue;
      const m = /^Pid:\s*(-?\d+)/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "latin1"));
      if (m) out.add(Number(m[1]));
    } catch {
      /* fd closed meanwhile */
    }
  }
  return out;
}

/** First time each zombie child (pid + start time) was seen, for the age guard. */
const zombieSeen = new Map<string, number>();

/**
 * Reap zombies that are our children only because we are a subreaper. `skip` holds pids we
 * know Bun is waiting for (the library's own spawns). Returns how many were reaped. Never throws.
 */
export function reapAdoptedZombies(skip: ReadonlySet<number>, minAgeMs = 2_000): number {
  const l = loadLibc();
  if (!l) return 0;
  let reaped = 0;
  try {
    const now = Date.now();
    const candidates: Array<[number, string]> = [];
    const live = new Set<string>();
    for (const [pid, st] of procTable()) {
      if (st.ppid !== process.pid || st.state !== "Z" || skip.has(pid)) continue;
      const key = `${pid}:${st.start}`;
      live.add(key);
      const first = zombieSeen.get(key);
      if (first === undefined) zombieSeen.set(key, now);
      else if (now - first >= minAgeMs) candidates.push([pid, key]);
    }
    for (const key of zombieSeen.keys()) if (!live.has(key)) zombieSeen.delete(key);
    if (!candidates.length) return 0;
    const bunWaits = pidfdTargets();
    for (const [pid, key] of candidates) {
      if (bunWaits.has(pid)) continue;
      if (l.waitpid(pid, null, WNOHANG) === pid) reaped++;
      zombieSeen.delete(key);
    }
  } catch {
    /* best effort */
  }
  return reaped;
}
