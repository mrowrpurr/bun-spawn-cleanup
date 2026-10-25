/**
 * Lazy libSystem bindings for the macOS backend and its daemon.
 *
 * Importing this module is free on every platform: `bun:ffi` is only required inside
 * `loadLibSystem()`, and `dlopen` only runs when `process.platform === "darwin"`. Off-macOS,
 * or if dlopen fails, `loadLibSystem()` returns `undefined` and every helper below returns
 * `undefined` / `false` / `[]`. Nothing here throws.
 *
 * Only non-variadic functions are bound: on Apple arm64 variadic arguments travel on the
 * stack, so binding `open(path, flags, mode)` or `fcntl` with a fixed signature would pass
 * the variadic part in the wrong place. `open` is bound with two arguments and only ever
 * called without O_CREAT.
 *
 * Struct layouts (verified on macOS 27 / arm64 / Bun 1.4.2, see
 * notes/2026/10/18/darwin/darwin-backend.md):
 *   - PROC_PIDUNIQIDENTIFIERINFO (flavor 17), 56 bytes: uuid[16], p_uniqueid u64 @16,
 *     p_puniqueid u64 @24, 3 x reserved u64. Declared in the private proc_info_private.h; the
 *     public SDK mirrors it as `struct crashinfo_proc_uniqidentifierinfo` in kern/kcdata.h.
 *     Zombies report nothing (proc_pidinfo returns 0), so an exited-but-unreaped
 *     intermediate cannot be attributed.
 *   - PROC_PIDT_SHORTBSDINFO (flavor 13), 64 bytes: pid u32 @0, ppid u32 @4, pgid u32 @8,
 *     status u32 @12, comm[16] @16, flags u32 @32, uid u32 @36, ...
 *   - struct sigaction (user side), 16 bytes: handler ptr @0, sa_mask u32 @8, sa_flags i32
 *     @12. SIG_IGN is handler == 1.
 *   - KERN_PROCARGS2: int argc, exec path + NUL padded to a multiple of 8, then argv and env
 *     strings (probed: argv[0] always starts at 4 + roundup(len(path) + 1, 8)).
 *   - struct kevent, 32 bytes: ident u64 @0, filter i16 @8, flags u16 @10, fflags u32 @12,
 *     data i64 @16, udata u64 @24.
 */

export const IS_DARWIN = process.platform === "darwin";

export const PROC_PIDT_SHORTBSDINFO = 13;
export const PROC_PIDT_SHORTBSDINFO_SIZE = 64;
export const PROC_PIDUNIQIDENTIFIERINFO = 17;
export const PROC_PIDUNIQIDENTIFIERINFO_SIZE = 56;

const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;

export const SIGKILL = 9;
export const SIGSTOP = 17;
export const SIGCONT = 19;

export const LOCK_EX = 2;
export const LOCK_NB = 4;
export const LOCK_UN = 8;

export const O_EVTONLY = 0x8000;

export const EVFILT_VNODE = -4;
export const EVFILT_PROC = -5;
export const EV_ADD = 0x0001;
export const EV_CLEAR = 0x0020;
export const NOTE_WRITE = 0x00000002;
export const NOTE_EXIT = 0x80000000;
export const NOTE_FORK = 0x40000000;
export const KEVENT_SIZE = 32;

/** Anything bun:ffi hands back for an `FFIType.ptr`. */
type Ptr = number | bigint | null;

interface LibSystemSymbols {
  proc_listallpids(buf: Ptr, size: number): number;
  proc_listchildpids(ppid: number, buf: Ptr, size: number): number;
  proc_listpgrppids(pgid: number, buf: Ptr, size: number): number;
  proc_pidinfo(pid: number, flavor: number, arg: bigint, buf: Ptr, size: number): number;
  sysctl(name: Ptr, namelen: number, oldp: Ptr, oldlenp: Ptr, newp: Ptr, newlen: bigint): number;
  sysctlbyname(name: Ptr, oldp: Ptr, oldlenp: Ptr, newp: Ptr, newlen: bigint): number;
  kqueue(): number;
  kevent(kq: number, changes: Ptr, nchanges: number, events: Ptr, nevents: number, timeout: Ptr): number;
  kill(pid: number, sig: number): number;
  sigaction(sig: number, act: Ptr, oldact: Ptr): number;
  flock(fd: number, op: number): number;
  open(path: Ptr, flags: number): number;
  close(fd: number): number;
}

interface LibSystem {
  readonly symbols: LibSystemSymbols;
  readonly ptr: (view: ArrayBufferView) => number;
}

let cached: LibSystem | undefined;
let loadAttempted = false;
let loadError: string | undefined;

/** dlopen libSystem once, lazily. `undefined` off-macOS or on failure. Never throws. */
export function loadLibSystem(): LibSystem | undefined {
  if (loadAttempted) return cached;
  loadAttempted = true;
  if (!IS_DARWIN) {
    loadError = "not darwin";
    return undefined;
  }
  try {
    // Runtime require keeps `bun:ffi` out of the module graph on other hosts.
    const { dlopen, FFIType: T, ptr } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen("/usr/lib/libSystem.B.dylib", {
      proc_listallpids: { args: [T.ptr, T.i32], returns: T.i32 },
      proc_listchildpids: { args: [T.i32, T.ptr, T.i32], returns: T.i32 },
      proc_listpgrppids: { args: [T.i32, T.ptr, T.i32], returns: T.i32 },
      proc_pidinfo: { args: [T.i32, T.i32, T.u64, T.ptr, T.i32], returns: T.i32 },
      sysctl: { args: [T.ptr, T.u32, T.ptr, T.ptr, T.ptr, T.u64], returns: T.i32 },
      sysctlbyname: { args: [T.ptr, T.ptr, T.ptr, T.ptr, T.u64], returns: T.i32 },
      kqueue: { args: [], returns: T.i32 },
      kevent: { args: [T.i32, T.ptr, T.i32, T.ptr, T.i32, T.ptr], returns: T.i32 },
      kill: { args: [T.i32, T.i32], returns: T.i32 },
      sigaction: { args: [T.i32, T.ptr, T.ptr], returns: T.i32 },
      flock: { args: [T.i32, T.i32], returns: T.i32 },
      open: { args: [T.ptr, T.i32], returns: T.i32 },
      close: { args: [T.i32], returns: T.i32 },
    });
    cached = { symbols: lib.symbols as unknown as LibSystemSymbols, ptr: ptr as unknown as (v: ArrayBufferView) => number };
    return cached;
  } catch (err) {
    loadError = `dlopen(libSystem) failed: ${err instanceof Error ? err.message : String(err)}`;
    return undefined;
  }
}

/** Why `loadLibSystem()` returned undefined, if it did. */
export function libSystemLoadError(): string | undefined {
  return loadError;
}

// ---------------------------------------------------------------------------
// Process listing and identity
// ---------------------------------------------------------------------------

/** Room for this many pids per listing call; grown on demand. */
let pidBuf = new Int32Array(4096);

function listPids(call: (buf: number, size: number) => number): number[] {
  const lib = loadLibSystem();
  if (!lib) return [];
  try {
    for (;;) {
      const n = call(lib.ptr(pidBuf), pidBuf.byteLength);
      if (n < 0) return [];
      // A full buffer may mean truncation: grow and retry.
      if (n >= pidBuf.length) {
        pidBuf = new Int32Array(pidBuf.length * 2);
        continue;
      }
      const out: number[] = [];
      for (let i = 0; i < n; i++) if (pidBuf[i]! > 0) out.push(pidBuf[i]!);
      return out;
    }
  } catch {
    return [];
  }
}

/** Every pid on the system (`proc_listallpids`). */
export function allPids(): number[] {
  return listPids((b, s) => loadLibSystem()!.symbols.proc_listallpids(b, s));
}

/** Direct children of `pid` by current ppid (`proc_listchildpids`). */
export function childPids(pid: number): number[] {
  return listPids((b, s) => loadLibSystem()!.symbols.proc_listchildpids(pid, b, s));
}

/** Members of process group `pgid` (`proc_listpgrppids`). */
export function pgrpPids(pgid: number): number[] {
  if (pgid <= 1) return [];
  return listPids((b, s) => loadLibSystem()!.symbols.proc_listpgrppids(pgid, b, s));
}

export interface UniqueIds {
  /** 64-bit per-boot unique id of the process (never reused until reboot). */
  uid: bigint;
  /** Unique id of the process that created it. Survives setsid, env -i, reparenting. */
  puid: bigint;
}

const uniqBuf = new Uint8Array(PROC_PIDUNIQIDENTIFIERINFO_SIZE);
const uniqView = new DataView(uniqBuf.buffer);

/** `p_uniqueid` / `p_puniqueid` of a live process; `undefined` if gone, a zombie, or unreadable. */
export function uniqueIds(pid: number): UniqueIds | undefined {
  const lib = loadLibSystem();
  if (!lib || pid <= 0) return undefined;
  try {
    const n = lib.symbols.proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0n, lib.ptr(uniqBuf), uniqBuf.byteLength);
    if (n !== PROC_PIDUNIQIDENTIFIERINFO_SIZE) return undefined;
    return { uid: uniqView.getBigUint64(16, true), puid: uniqView.getBigUint64(24, true) };
  } catch {
    return undefined;
  }
}

export interface ShortInfo {
  ppid: number;
  pgid: number;
  /** Effective user id of the process. */
  user: number;
  comm: string;
}

const shortBuf = new Uint8Array(PROC_PIDT_SHORTBSDINFO_SIZE);
const shortView = new DataView(shortBuf.buffer);

/** ppid, pgid, user and command name; `undefined` if gone, a zombie, or unreadable. */
export function shortInfo(pid: number): ShortInfo | undefined {
  const lib = loadLibSystem();
  if (!lib || pid <= 0) return undefined;
  try {
    const n = lib.symbols.proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0n, lib.ptr(shortBuf), shortBuf.byteLength);
    if (n !== PROC_PIDT_SHORTBSDINFO_SIZE) return undefined;
    const comm = new TextDecoder().decode(shortBuf.subarray(16, 32)).replace(/\0[\s\S]*$/, "");
    return { ppid: shortView.getUint32(4, true), pgid: shortView.getUint32(8, true), user: shortView.getUint32(36, true), comm };
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Environment of another process (KERN_PROCARGS2, what `ps -E` uses)
// ---------------------------------------------------------------------------

let argsBuf: Uint8Array | undefined;
const argsLen = new BigUint64Array(1);

/**
 * The environment `pid` was exec'd with, as `NAME=value` strings. Same user only; with SIP
 * on, processes flagged CS_RESTRICT hide it. `undefined` when unreadable.
 *
 * Buffer layout: int argc, exec path, NUL padding to a multiple of 8 (counted from offset
 * 4), argc argv strings, then env strings, each NUL-terminated, ending at an empty string or
 * the end of the data. The computed argv start matters when argv[0] is empty: skipping
 * every NUL after the path (what `ps` does) would swallow it and misread the first env
 * entry as an argument.
 */
export function procEnv(pid: number): string[] | undefined {
  const lib = loadLibSystem();
  if (!lib || pid <= 0) return undefined;
  try {
    if (!argsBuf) {
      const max = new Int32Array(1);
      const mib = new Int32Array([CTL_KERN, KERN_ARGMAX]);
      argsLen[0] = 4n;
      const ok = lib.symbols.sysctl(lib.ptr(mib), 2, lib.ptr(max), lib.ptr(argsLen), null, 0n) === 0;
      argsBuf = new Uint8Array(ok && max[0]! > 0 ? max[0]! : 1 << 20);
    }
    const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
    argsLen[0] = BigInt(argsBuf.byteLength);
    if (lib.symbols.sysctl(lib.ptr(mib), 3, lib.ptr(argsBuf), lib.ptr(argsLen), null, 0n) !== 0) return undefined;
    const len = Number(argsLen[0]);
    if (len < 4) return undefined;
    const buf = argsBuf;
    const argc = new DataView(buf.buffer, 0, 4).getInt32(0, true);
    let i = 4;
    const skipString = () => {
      while (i < len && buf[i] !== 0) i++;
    };
    skipString(); // exec path
    const pathEnd = i;
    while (i < len && buf[i] === 0) i++; // padding (and an empty argv[0], if any)
    const argvStart = 4 + Math.ceil((pathEnd - 4 + 1) / 8) * 8;
    // Layout as probed: start argv at the computed offset. A run of NULs ending before it
    // would contradict the layout; then keep the skip-all heuristic.
    if (i >= argvStart) i = argvStart;
    for (let a = 0; a < argc && i < len; a++) {
      skipString();
      i++;
    }
    const env: string[] = [];
    const dec = new TextDecoder("latin1");
    while (i < len) {
      const start = i;
      skipString();
      if (i === start) break;
      env.push(dec.decode(buf.subarray(start, i)));
      i++;
    }
    return env;
  } catch {
    return undefined;
  }
}

let bootId: string | undefined;

/**
 * `kern.bootsessionuuid`: changes at every boot. Unique ids restart from a small number at
 * boot, so a ledger from another boot names strangers and must never drive a kill.
 */
export function bootSessionId(): string | undefined {
  if (bootId !== undefined) return bootId;
  const lib = loadLibSystem();
  if (!lib) return undefined;
  try {
    const name = new TextEncoder().encode("kern.bootsessionuuid\0");
    const buf = new Uint8Array(128);
    const len = new BigUint64Array([BigInt(buf.byteLength)]);
    if (lib.symbols.sysctlbyname(lib.ptr(name), lib.ptr(buf), lib.ptr(len), null, 0n) !== 0) return undefined;
    bootId = new TextDecoder().decode(buf.subarray(0, Number(len[0]))).replace(/\0[\s\S]*$/, "");
    return bootId;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Signals, locks, kqueue
// ---------------------------------------------------------------------------

/** kill(2). `pid` may be negative (process group). True on success. */
export function sendSignal(pid: number, sig: number): boolean {
  const lib = loadLibSystem();
  if (!lib || pid === 0 || pid === -1) return false; // never broadcast
  try {
    return lib.symbols.kill(pid, sig) === 0;
  } catch {
    return false;
  }
}

const SIG_IGN = 1n;
const sigBuf = new Uint8Array(16);

/**
 * Is `signo` currently ignored (SIG_IGN)? A process started under `nohup`, or as a
 * background job of a non-interactive shell (SIGINT/SIGQUIT), inherits ignored signals;
 * installing a listener would replace SIG_IGN and make that signal fatal again.
 * `undefined` when the query fails.
 */
export function signalIgnored(signo: number): boolean | undefined {
  const lib = loadLibSystem();
  if (!lib) return undefined;
  try {
    sigBuf.fill(0);
    if (lib.symbols.sigaction(signo, null, lib.ptr(sigBuf)) !== 0) return undefined;
    return new DataView(sigBuf.buffer).getBigUint64(0, true) === SIG_IGN;
  } catch {
    return undefined;
  }
}

/** flock(2). True on success. */
export function flock(fd: number, op: number): boolean {
  const lib = loadLibSystem();
  if (!lib) return false;
  try {
    return lib.symbols.flock(fd, op) === 0;
  } catch {
    return false;
  }
}

/** open(path, O_EVTONLY): an fd usable only for kqueue vnode events. -1 on failure. */
export function openEventOnly(path: string): number {
  const lib = loadLibSystem();
  if (!lib) return -1;
  try {
    const cpath = new TextEncoder().encode(path + "\0");
    return lib.symbols.open(lib.ptr(cpath), O_EVTONLY);
  } catch {
    return -1;
  }
}

export function closeFd(fd: number): void {
  if (fd < 0) return;
  try {
    loadLibSystem()?.symbols.close(fd);
  } catch {
    /* ignore */
  }
}

/** A new kqueue fd, or -1. */
export function kqueue(): number {
  try {
    return loadLibSystem()?.symbols.kqueue() ?? -1;
  } catch {
    return -1;
  }
}

export interface KEvent {
  ident: number;
  filter: number;
  flags: number;
  fflags: number;
  data: number;
}

const changeBuf = new Uint8Array(KEVENT_SIZE);
const changeView = new DataView(changeBuf.buffer);

/**
 * Register one kevent. Returns false when the kernel refused it (for EVFILT_PROC: the
 * process is already gone).
 */
export function keventRegister(kq: number, ident: number, filter: number, flags: number, fflags: number): boolean {
  const lib = loadLibSystem();
  if (!lib || kq < 0) return false;
  try {
    changeBuf.fill(0);
    changeView.setBigUint64(0, BigInt(ident), true);
    changeView.setInt16(8, filter, true);
    changeView.setUint16(10, flags, true);
    changeView.setUint32(12, fflags >>> 0, true);
    return lib.symbols.kevent(kq, lib.ptr(changeBuf), 1, null, 0, null) >= 0;
  } catch {
    return false;
  }
}

const eventBuf = new Uint8Array(KEVENT_SIZE * 64);
const timeout = new BigInt64Array(2);

/** Wait up to `ms` for events. Blocks the calling thread (the daemon has nothing else to do). */
export function keventWait(kq: number, ms: number): KEvent[] {
  const lib = loadLibSystem();
  if (!lib || kq < 0) return [];
  try {
    timeout[0] = BigInt(Math.floor(ms / 1000));
    timeout[1] = BigInt((ms % 1000) * 1_000_000);
    const n = lib.symbols.kevent(kq, null, 0, lib.ptr(eventBuf), eventBuf.byteLength / KEVENT_SIZE, lib.ptr(timeout));
    if (n <= 0) return [];
    const view = new DataView(eventBuf.buffer);
    const out: KEvent[] = [];
    for (let i = 0; i < n; i++) {
      const o = i * KEVENT_SIZE;
      out.push({
        ident: Number(view.getBigUint64(o, true)),
        filter: view.getInt16(o + 8, true),
        flags: view.getUint16(o + 10, true),
        fflags: view.getUint32(o + 12, true),
        data: Number(view.getBigInt64(o + 16, true)),
      });
    }
    return out;
  } catch {
    return [];
  }
}
