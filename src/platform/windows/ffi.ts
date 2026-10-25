/**
 * Lazy kernel32.dll bindings for the Windows backend.
 *
 * Importing this module is free on every platform: `bun:ffi` is only required inside
 * `loadKernel32()`, and `dlopen` only runs when `process.platform === "win32"`.
 * Off-Windows, or if dlopen fails, `loadKernel32()` returns `undefined`. Nothing here throws.
 *
 * Struct sizes and the self-assign strategy were validated empirically in the ndwrap
 * project's `scratch/job-object/RESULTS.md` (Bun 1.3/1.4, Windows 11 x64):
 *   - sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) == 144 on x64; SetInformationJobObject
 *     rejects every other cb with ERROR_BAD_LENGTH (24), so a wrong size fails loudly.
 *   - Bun.spawn never sets CREATE_BREAKAWAY_FROM_JOB; `detached` / `windowsHide` do not
 *     change job membership.
 *   - Nested jobs (self-assign while already inside a job) work on Windows 8+.
 */

export const IS_WINDOWS = process.platform === "win32";

// ---------------------------------------------------------------------------
// Win32 constants
// ---------------------------------------------------------------------------

/** JOBOBJECTINFOCLASS::JobObjectExtendedLimitInformation */
export const JobObjectExtendedLimitInformation = 9;

/** JOBOBJECTINFOCLASS::JobObjectBasicAccountingInformation */
export const JobObjectBasicAccountingInformation = 1;

/** LimitFlags bit: kill all members when the last handle to the job closes. */
export const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

/** LimitFlags bit: members may create children with CREATE_BREAKAWAY_FROM_JOB. Opt-in only. */
export const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;

/**
 * sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION) == 48, ActiveProcesses at offset 40:
 *   @0 TotalUserTime @8 TotalKernelTime @16 ThisPeriodTotalUserTime @24 ThisPeriodTotalKernelTime
 *   @32 TotalPageFaultCount @36 TotalProcesses @40 ActiveProcesses @44 TotalTerminatedProcesses
 */
export const JOBOBJECT_BASIC_ACCOUNTING_INFORMATION_SIZE = 48;
export const ACTIVE_PROCESSES_OFFSET = 40;

/** sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) on x64. Load-bearing; see header comment. */
export const JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE = 144;

/**
 * Byte offset of BasicLimitInformation.LimitFlags:
 *   @0  PerProcessUserTimeLimit  LARGE_INTEGER (8)
 *   @8  PerJobUserTimeLimit      LARGE_INTEGER (8)
 *   @16 LimitFlags               DWORD         (4)
 */
export const LIMIT_FLAGS_OFFSET = 16;

export const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
export const PROCESS_SET_QUOTA = 0x0100;
export const PROCESS_TERMINATE = 0x0001;
/** Access right needed to wait on a process handle. */
export const SYNCHRONIZE = 0x0010_0000;
/** WaitForSingleObject: the object is signaled (for a process: it has exited). */
export const WAIT_OBJECT_0 = 0;

/** GetExitCodeProcess reports this while the process is still running. */
export const STILL_ACTIVE = 259;

/** JOBOBJECTINFOCLASS::JobObjectBasicProcessIdList */
export const JobObjectBasicProcessIdList = 3;

/**
 * JOBOBJECT_BASIC_PROCESS_ID_LIST on x64:
 *   @0 NumberOfAssignedProcesses DWORD @4 NumberOfProcessIdsInList DWORD @8 ProcessIdList ULONG_PTR[]
 */
export const PROCESS_ID_LIST_HEADER_SIZE = 8;
export const PROCESS_ID_LIST_ENTRY_SIZE = 8;

/** GetLastError: the buffer was too small for the whole answer. */
export const ERROR_MORE_DATA = 234;

/** CreateToolhelp32Snapshot flag: include every process in the system. */
export const TH32CS_SNAPPROCESS = 0x2;

/**
 * sizeof(PROCESSENTRY32W) on x64 == 568 (Process32FirstW rejects a wrong dwSize):
 *   @0 dwSize @4 cntUsage @8 th32ProcessID @16 th32DefaultHeapID (ULONG_PTR) @24 th32ModuleID
 *   @28 cntThreads @32 th32ParentProcessID @36 pcPriClassBase @40 dwFlags @44 szExeFile[260]
 */
export const PROCESSENTRY32W_SIZE = 568;
export const PE32_PID_OFFSET = 8;
export const PE32_PPID_OFFSET = 32;

/** Anything bun:ffi hands back for an `FFIType.ptr`: a JS number (possibly float64-rounded) or bigint. */
export type Ptr = number | bigint | null;

export interface Kernel32Symbols {
  CreateJobObjectW(securityAttributes: Ptr, name: Ptr): Ptr;
  SetInformationJobObject(hJob: Ptr, infoClass: number, info: Ptr, cbInfo: number): number;
  QueryInformationJobObject(hJob: Ptr, infoClass: number, info: Ptr, cbInfo: number, outLen: Ptr): number;
  AssignProcessToJobObject(hJob: Ptr, hProcess: Ptr): number;
  /** hJob may be null to ask "in ANY job"; never do that (ambient console job gives false positives). */
  IsProcessInJob(hProcess: Ptr, hJob: Ptr, outBool: Ptr): number;
  TerminateJobObject(hJob: Ptr, exitCode: number): number;
  GetCurrentProcess(): Ptr;
  OpenProcess(desiredAccess: number, inheritHandle: number, pid: number): Ptr;
  GetExitCodeProcess(hProcess: Ptr, outCode: Ptr): number;
  TerminateProcess(hProcess: Ptr, exitCode: number): number;
  WaitForSingleObject(handle: Ptr, ms: number): number;
  /** Returns INVALID_HANDLE_VALUE (-1) on failure, hence `i64_fast`, not `ptr`. */
  CreateToolhelp32Snapshot(flags: number, pid: number): number | bigint;
  Process32FirstW(hSnapshot: Ptr, entry: Ptr): number;
  Process32NextW(hSnapshot: Ptr, entry: Ptr): number;
  GetProcessTimes(hProcess: Ptr, creation: Ptr, exit: Ptr, kernel: Ptr, user: Ptr): number;
  CloseHandle(handle: Ptr): number;
  GetLastError(): number;
}

export interface Kernel32 {
  readonly symbols: Kernel32Symbols;
  /** bun:ffi's `ptr()`, so callers never import bun:ffi themselves. */
  readonly ptr: (view: ArrayBufferView) => number;
}

let cached: Kernel32 | undefined;
let loadAttempted = false;
let loadError: string | undefined;

/** dlopen kernel32.dll once, lazily. `undefined` off-Windows or on failure. Never throws. */
export function loadKernel32(): Kernel32 | undefined {
  if (loadAttempted) return cached;
  loadAttempted = true;

  if (!IS_WINDOWS) {
    loadError = "not windows";
    return undefined;
  }

  try {
    // Runtime require keeps `bun:ffi` out of the module graph on non-Windows hosts.
    const ffi = require("bun:ffi") as typeof import("bun:ffi");
    const { dlopen, FFIType, ptr } = ffi;

    const lib = dlopen("kernel32.dll", {
      CreateJobObjectW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      SetInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      QueryInformationJobObject: {
        args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32, FFIType.ptr],
        returns: FFIType.i32,
      },
      AssignProcessToJobObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      IsProcessInJob: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      TerminateJobObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      GetCurrentProcess: { args: [], returns: FFIType.ptr },
      OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
      GetExitCodeProcess: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
      CreateToolhelp32Snapshot: { args: [FFIType.u32, FFIType.u32], returns: FFIType.i64_fast },
      Process32FirstW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      Process32NextW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
      GetProcessTimes: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
      CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetLastError: { args: [], returns: FFIType.u32 },
    });

    cached = {
      symbols: lib.symbols as unknown as Kernel32Symbols,
      ptr: ptr as unknown as (view: ArrayBufferView) => number,
    };
    return cached;
  } catch (err) {
    loadError = `dlopen(kernel32.dll) failed: ${err instanceof Error ? err.message : String(err)}`;
    cached = undefined;
    return undefined;
  }
}

/** Why `loadKernel32()` returned undefined, if it did. */
export function kernel32LoadError(): string | undefined {
  return loadError;
}

/** GetLastError, defensively. */
export function lastError(k32: Kernel32 | undefined): number {
  try {
    return k32?.symbols.GetLastError() ?? -1;
  } catch {
    return -1;
  }
}

/** Close a handle, swallowing everything. For process handles and per-child job handles only. */
export function closeQuietly(k32: Kernel32, handle: Ptr): void {
  if (!handle) return;
  try {
    k32.symbols.CloseHandle(handle);
  } catch {
    /* never throw from cleanup paths */
  }
}

/**
 * Stamp LimitFlags onto a fresh job (default: KILL_ON_JOB_CLOSE). A fresh job has all limits
 * zeroed, so writing the flags into a zeroed struct is exactly `LimitFlags |= flags`.
 */
export function setJobLimitFlags(k32: Kernel32, hJob: Ptr, flags: number = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE): boolean {
  const info = new Uint8Array(JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE);
  new DataView(info.buffer).setUint32(LIMIT_FLAGS_OFFSET, flags, true);
  return (
    k32.symbols.SetInformationJobObject(
      hJob,
      JobObjectExtendedLimitInformation,
      k32.ptr(info),
      JOBOBJECT_EXTENDED_LIMIT_INFORMATION_SIZE,
    ) !== 0
  );
}

/** Number of live processes in a job, or `undefined` if the query failed. */
export function jobActiveProcesses(k32: Kernel32, hJob: Ptr): number | undefined {
  const info = new Uint8Array(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION_SIZE);
  const ok = k32.symbols.QueryInformationJobObject(
    hJob,
    JobObjectBasicAccountingInformation,
    k32.ptr(info),
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION_SIZE,
    null,
  );
  return ok !== 0 ? new DataView(info.buffer).getUint32(ACTIVE_PROCESSES_OFFSET, true) : undefined;
}

/** IsProcessInJob against a SPECIFIC job handle. `undefined` if the API call failed. */
export function isProcessInJob(k32: Kernel32, hProcess: Ptr, hJob: Ptr): boolean | undefined {
  const out = new Int32Array(1);
  const ok = k32.symbols.IsProcessInJob(hProcess, hJob, k32.ptr(out));
  return ok !== 0 ? out[0] !== 0 : undefined;
}

/** Open `pid` with `access`, run `fn`, close. `undefined` when the process cannot be opened. */
export function withProcessHandle<T>(
  k32: Kernel32,
  pid: number,
  access: number,
  fn: (h: Ptr) => T,
): T | undefined {
  let h: Ptr = null;
  try {
    h = k32.symbols.OpenProcess(access, 0, pid);
    if (!h) return undefined;
    return fn(h);
  } catch {
    return undefined;
  } finally {
    closeQuietly(k32, h);
  }
}

/**
 * Is `pid` still running? Uses OpenProcess + GetExitCodeProcess(STILL_ACTIVE). Returns false
 * when the process cannot be opened at all (gone, or access denied, which for our own
 * descendants never happens). Windows only; `undefined` elsewhere.
 */
export function isPidAlive(pid: number): boolean | undefined {
  const k32 = loadKernel32();
  if (!k32) return undefined;
  const alive = withProcessHandle(k32, pid, PROCESS_QUERY_LIMITED_INFORMATION, (h) => {
    const code = new Uint32Array(1);
    if (k32.symbols.GetExitCodeProcess(h, k32.ptr(code)) === 0) return false;
    return code[0] === STILL_ACTIVE;
  });
  return alive ?? false;
}

/**
 * Pids of every live member of `hJob` (nested jobs' members included), or `undefined` if the
 * query failed. Grows the buffer on ERROR_MORE_DATA, or when the kernel filled fewer ids than
 * it reports assigned (the job grew between calls). Never throws.
 */
export function jobProcessIds(k32: Kernel32, hJob: Ptr): number[] | undefined {
  try {
    let capacity = 64;
    for (let attempt = 0; attempt < 6; attempt++) {
      const size = PROCESS_ID_LIST_HEADER_SIZE + capacity * PROCESS_ID_LIST_ENTRY_SIZE;
      const buf = new Uint8Array(size);
      const dv = new DataView(buf.buffer);
      const ok = k32.symbols.QueryInformationJobObject(hJob, JobObjectBasicProcessIdList, k32.ptr(buf), size, null);
      const assigned = dv.getUint32(0, true);
      if (ok === 0) {
        if (lastError(k32) !== ERROR_MORE_DATA) return undefined;
        capacity = Math.max(capacity * 2, assigned + 16);
        continue;
      }
      const inList = Math.min(dv.getUint32(4, true), capacity);
      if (inList < assigned) {
        capacity = Math.max(capacity * 2, assigned + 16);
        continue;
      }
      const pids: number[] = [];
      for (let i = 0; i < inList; i++) {
        pids.push(Number(dv.getBigUint64(PROCESS_ID_LIST_HEADER_SIZE + i * PROCESS_ID_LIST_ENTRY_SIZE, true)));
      }
      return pids;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** One toolhelp snapshot as `pid -> parent pid`. `undefined` if the snapshot failed. Never throws. */
export function processParentMap(k32: Kernel32): Map<number, number> | undefined {
  let snap: number | bigint = -1;
  try {
    snap = k32.symbols.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap === -1 || snap === -1n || !snap) return undefined;
    const entry = new Uint8Array(PROCESSENTRY32W_SIZE);
    const dv = new DataView(entry.buffer);
    dv.setUint32(0, PROCESSENTRY32W_SIZE, true);
    const p = k32.ptr(entry);
    const map = new Map<number, number>();
    let ok = k32.symbols.Process32FirstW(snap, p);
    while (ok !== 0) {
      map.set(dv.getUint32(PE32_PID_OFFSET, true), dv.getUint32(PE32_PPID_OFFSET, true));
      dv.setUint32(0, PROCESSENTRY32W_SIZE, true);
      ok = k32.symbols.Process32NextW(snap, p);
    }
    return map;
  } catch {
    return undefined;
  } finally {
    if (snap !== -1 && snap !== -1n && snap) closeQuietly(k32, snap);
  }
}

/** Process creation time as a FILETIME (100 ns ticks), or `undefined` if the query failed. */
export function processCreationTime(k32: Kernel32, hProcess: Ptr): bigint | undefined {
  try {
    const times = new BigUint64Array(4);
    const base = k32.ptr(times);
    const ok = k32.symbols.GetProcessTimes(hProcess, base, base + 8, base + 16, base + 24);
    return ok !== 0 ? times[0] : undefined;
  } catch {
    return undefined;
  }
}
