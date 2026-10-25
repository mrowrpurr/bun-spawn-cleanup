/**
 * Landlock: the kernel's unprivileged, irrevocable, inherited sandbox (kernel 5.13+,
 * `landlock` in /sys/kernel/security/lsm; on by default in Ubuntu, Fedora, Arch, Debian 12).
 *
 * Used by the cgroup backend to close the one hole cgroup v2 leaves open for same-UID
 * processes: after the owner has moved itself into its cgroup, it applies a ruleset that
 * denies every write-type access under the cgroup2 mount (`/sys/fs/cgroup`) and allows them
 * everywhere else. Every process spawned afterwards inherits the ruleset and cannot drop
 * it, so no descendant can write its pid into another `cgroup.procs`, however hard it
 * tries. The owner itself loses cgroupfs writes too; it delegates those to its supervisor,
 * which was started before the ruleset and is therefore outside it.
 *
 * On ABI 6+ (kernel 6.12+) the ruleset also scopes signals: a sandboxed process cannot
 * signal a process outside the sandbox. That protects the supervisor from a descendant's
 * `kill -9`, and also means the owner can no longer signal unrelated processes.
 *
 * Cost, stated plainly: Landlock requires `no_new_privs`, so setuid binaries (`sudo`, `su`,
 * `snap`, `mount`) run by the owner or any descendant no longer gain privileges.
 *
 * Landlock has no deny rules, only allow rules beneath paths, so "everything except X" is
 * expressed by allowing each sibling along the path to X: every entry of `/` except `sys`,
 * every entry of `/sys` except `fs`, every entry of `/sys/fs` except `cgroup`. That list is
 * a snapshot: a top-level directory created later (a new `/foo`, or a new entry directly
 * under `/sys` or `/sys/fs`) is unwritable for the tree, and only the cgroup2 mount named
 * in /proc/self/mountinfo is denied, not a second bind mount of it elsewhere.
 *
 * Lazy `bun:ffi`; importing this module does nothing off-Linux.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// uapi/linux/landlock.h
const SYS_landlock_create_ruleset = 444;
const SYS_landlock_add_rule = 445;
const SYS_landlock_restrict_self = 446;
const LANDLOCK_CREATE_RULESET_VERSION = 1;
const LANDLOCK_RULE_PATH_BENEATH = 1;
/** landlock_restrict_self flag: apply to every thread of the process, not just the caller. */
const LANDLOCK_RESTRICT_SELF_TSYNC = 1 << 3;

const FS_EXECUTE = 1n << 0n;
const FS_WRITE_FILE = 1n << 1n;
const FS_READ_FILE = 1n << 2n;
const FS_REMOVE_DIR = 1n << 4n;
const FS_REMOVE_FILE = 1n << 5n;
const FS_MAKE_CHAR = 1n << 6n;
const FS_MAKE_DIR = 1n << 7n;
const FS_MAKE_REG = 1n << 8n;
const FS_MAKE_SOCK = 1n << 9n;
const FS_MAKE_FIFO = 1n << 10n;
const FS_MAKE_BLOCK = 1n << 11n;
const FS_MAKE_SYM = 1n << 12n;
const FS_REFER = 1n << 13n; // ABI 2
const FS_TRUNCATE = 1n << 14n; // ABI 3
void FS_EXECUTE;
void FS_READ_FILE;

const SCOPE_SIGNAL = 1n << 1n; // ABI 6

const PR_SET_NO_NEW_PRIVS = 38;
const O_PATH = 0x200000;
const O_CLOEXEC = 0x80000;

export interface LandlockResult {
  /** Landlock ABI version the kernel offers. */
  abi: number;
  /** Signal scoping was applied (ABI 6+). */
  scopedSignals: boolean;
  /**
   * The ruleset was applied to every thread (TSYNC). Without it, Landlock and no_new_privs
   * are per-thread: a Worker created before the first spawn, and anything it spawns, stays
   * outside the sandbox.
   */
  allThreads: boolean;
}

interface Libc {
  symbols: {
    syscall(nr: number | bigint, a: number | bigint, b: number | bigint, c: number | bigint, d: number | bigint): bigint | number;
    prctl(option: number, a: bigint, b: bigint, c: bigint, d: bigint): number;
    open(path: Uint8Array, flags: number): number;
    close(fd: number): number;
    __errno_location(): number | bigint;
  };
  ptr: (view: ArrayBufferView) => number;
  errno(): number;
}

let libc: Libc | undefined;
function loadLibc(): Libc {
  if (libc) return libc;
  const ffi = require("bun:ffi") as typeof import("bun:ffi");
  const { dlopen, FFIType, ptr, read } = ffi;
  const lib = dlopen("libc.so.6", {
    syscall: { args: [FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64, FFIType.i64], returns: FFIType.i64 },
    prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    open: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
    __errno_location: { args: [], returns: FFIType.ptr },
  });
  const symbols = lib.symbols as unknown as Libc["symbols"];
  libc = {
    symbols,
    ptr: ptr as unknown as (view: ArrayBufferView) => number,
    errno: () => read.i32(Number(symbols.__errno_location()), 0),
  };
  return libc;
}

const cstr = (s: string) => new TextEncoder().encode(s + "\0");

/** Landlock ABI version, or an error string (not enabled, kernel too old). */
export function landlockAbi(): number | string {
  try {
    const l = loadLibc();
    const r = Number(l.symbols.syscall(SYS_landlock_create_ruleset, 0, 0, LANDLOCK_CREATE_RULESET_VERSION, 0));
    if (r < 0) {
      const e = l.errno();
      return e === 38 ? "landlock not supported by this kernel (ENOSYS)" : e === 95 ? "landlock disabled (EOPNOTSUPP; not in lsm= list)" : `landlock_create_ruleset errno ${e}`;
    }
    return r;
  } catch (e) {
    return `ffi: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Apply a ruleset to the calling thread that forbids every write-type filesystem access
 * beneath `denyRoot` (must be an absolute path with at least one component) and permits it
 * everywhere else, plus signal scoping when available. Irreversible for this process and
 * inherited by every future child. Returns a reason string on failure, in which case
 * nothing was applied.
 */
export function restrictCgroupWrites(denyRoot: string): LandlockResult | string {
  const abiOrErr = landlockAbi();
  if (typeof abiOrErr === "string") return abiOrErr;
  const abi = abiOrErr;
  const l = loadLibc();

  let handled =
    FS_WRITE_FILE | FS_REMOVE_DIR | FS_REMOVE_FILE | FS_MAKE_CHAR | FS_MAKE_DIR | FS_MAKE_REG |
    FS_MAKE_SOCK | FS_MAKE_FIFO | FS_MAKE_BLOCK | FS_MAKE_SYM;
  // Without REFER handled (and allowed), ABI 2+ would forbid every cross-directory rename
  // and link, which would break ordinary programs. Handle it and allow it everywhere.
  if (abi >= 2) handled |= FS_REFER;
  if (abi >= 3) handled |= FS_TRUNCATE;
  const fileCompatible = FS_WRITE_FILE | (abi >= 3 ? FS_TRUNCATE : 0n);
  const scoped = abi >= 6 ? SCOPE_SIGNAL : 0n;

  // struct landlock_ruleset_attr { u64 handled_access_fs; u64 handled_access_net; u64 scoped; }
  // The kernel accepts any size from 8 up to what it knows; pass 24 only when `scoped` is used.
  const attrSize = scoped ? 24 : 8;
  const attr = new Uint8Array(attrSize);
  const dv = new DataView(attr.buffer);
  dv.setBigUint64(0, handled, true);
  if (scoped) dv.setBigUint64(16, scoped, true);
  const ruleset = Number(l.symbols.syscall(SYS_landlock_create_ruleset, l.ptr(attr), attrSize, 0, 0));
  if (ruleset < 0) return `landlock_create_ruleset failed, errno ${l.errno()}`;

  const closeFd = (fd: number) => {
    try {
      l.symbols.close(fd);
    } catch {
      /* ignore */
    }
  };

  try {
    // struct landlock_path_beneath_attr { u64 allowed_access; s32 parent_fd; } __packed  (12 bytes)
    const addRule = (path: string, isDir: boolean): string | undefined => {
      const fd = l.symbols.open(cstr(path), O_PATH | O_CLOEXEC);
      if (fd < 0) return undefined; // vanished or unreadable entry: nothing to allow
      try {
        const rule = new Uint8Array(12);
        const rdv = new DataView(rule.buffer);
        rdv.setBigUint64(0, isDir ? handled : fileCompatible, true);
        rdv.setInt32(8, fd, true);
        const r = Number(l.symbols.syscall(SYS_landlock_add_rule, ruleset, LANDLOCK_RULE_PATH_BENEATH, l.ptr(rule), 0));
        if (r < 0) return `landlock_add_rule(${path}) failed, errno ${l.errno()}`;
        return undefined;
      } finally {
        closeFd(fd);
      }
    };

    // Allow every sibling along the way down to denyRoot; never denyRoot itself.
    const parts = denyRoot.split("/").filter(Boolean);
    if (parts.length === 0) return "denyRoot must not be /";
    let dir = "/";
    for (const next of parts) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch (e) {
        return `readdir(${dir}) failed: ${(e as NodeJS.ErrnoException).code}`;
      }
      for (const name of entries) {
        if (name === next) continue;
        const full = join(dir, name);
        let isDir: boolean;
        try {
          isDir = statSync(full).isDirectory(); // follows symlinks (/bin -> usr/bin)
        } catch {
          continue;
        }
        const err = addRule(full, isDir);
        if (err) return err;
      }
      dir = join(dir, next);
    }

    if (l.symbols.prctl(PR_SET_NO_NEW_PRIVS, 1n, 0n, 0n, 0n) !== 0) {
      return `prctl(PR_SET_NO_NEW_PRIVS) failed, errno ${l.errno()}`;
    }
    // Prefer TSYNC (all threads); an older kernel rejects the flag with EINVAL, then apply to
    // the calling thread only and report it.
    let r = Number(l.symbols.syscall(SYS_landlock_restrict_self, ruleset, LANDLOCK_RESTRICT_SELF_TSYNC, 0, 0));
    let allThreads = r === 0;
    if (r < 0 && l.errno() === 22) {
      r = Number(l.symbols.syscall(SYS_landlock_restrict_self, ruleset, 0, 0, 0));
      allThreads = false;
    }
    if (r < 0) return `landlock_restrict_self failed, errno ${l.errno()}`;
    return { abi, scopedSignals: scoped !== 0n, allThreads };
  } finally {
    closeFd(ruleset);
  }
}
