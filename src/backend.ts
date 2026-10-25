/**
 * The contract every platform backend implements. One backend per platform:
 *
 *   src/platform/windows  — Job Object with KILL_ON_JOB_CLOSE (kernel guarantee)
 *   src/platform/linux    — cgroup v2 + cgroup.kill (kernel), else env marker scan (best-effort)
 *   src/platform/darwin   — kernel lineage ids + env marker + ledger, owner hooks, kqueue daemon (best-effort)
 *
 * Backends must never throw from `ensure()` or `status()`; a backend that cannot
 * establish containment reports `active: false` with a reason and `spawn()` still
 * works as a plain `Bun.spawn` passthrough.
 *
 * Backends never run anything at import. `src/core.ts` selects one lazily and calls
 * `ensure()` from `configureSpawnCleanup()`; `src/index.ts` (the root entry) calls that at
 * import, which is the one place the library has a side effect.
 */

export type Platform = "windows" | "linux" | "darwin" | "other";

/**
 * How strong the cleanup promise is once `ensure()` reports `active: true`.
 *
 * - `kernel`      — the OS kills every descendant when the owner dies, by any means,
 *                   with no cooperation from the owner or the children.
 * - `best-effort` — a userland watchdog / scan; cooperative or uncooperative
 *                   descendants can escape in documented ways.
 * - `none`        — passthrough; nothing beyond what `Bun.spawn` already does.
 */
export type Guarantee = "kernel" | "best-effort" | "none";

export interface CleanupStatus {
  platform: Platform;
  /** Backend identifier, e.g. `windows-job-object`. */
  backend: string;
  guarantee: Guarantee;
  /** True when the containment mechanism is in place for the current process. */
  active: boolean;
  /** Why `active` is false (not this platform, disabled by env, OS error, ...). */
  reason?: string;
}

export interface KillTreeResult {
  /** True when the backend had a kernel-level handle on the tree and terminated it. */
  tracked: boolean;
  /** Human-readable note, mostly for diagnostics/tests. */
  detail?: string;
}

/** Narrowest slice of `Bun.Subprocess` a backend needs. */
export interface SpawnedProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/**
 * Options accepted by `configureSpawnCleanup()`. Every field mirrors an environment knob
 * (named in the comments) and is read exactly once, at setup. When both are present the
 * option wins over the env var; env stays available for out-of-process configuration and
 * for tests. Windows has no knobs beyond `disable`.
 */
export interface CleanupOptions {
  /** `BUN_SPAWN_CLEANUP_DISABLE`: skip containment entirely; `spawn` becomes plain `Bun.spawn`. */
  disable?: boolean;
  linux?: {
    /**
     * `BUN_SPAWN_CLEANUP_LINUX_MECHANISM`: `auto` (default) tries cgroup v2 and falls back to
     * the env-marker scan; `cgroup` reports `active: false` instead of falling back;
     * `best-effort` skips cgroups.
     */
    mechanism?: "auto" | "cgroup" | "best-effort";
    /**
     * `BUN_SPAWN_CLEANUP_LINUX_LANDLOCK`: `false` keeps the cgroup but skips the Landlock
     * sandbox, for owners whose descendants must run setuid programs such as `sudo`.
     */
    landlock?: boolean;
  };
  darwin?: {
    /** `BUN_SPAWN_CLEANUP_DARWIN_DAEMON`: `auto` (default) starts the kqueue daemon at setup; `off` does not. */
    daemon?: "auto" | "off";
    /** `BUN_SPAWN_CLEANUP_DIR`: ledger directory, default `$TMPDIR/bun-spawn-cleanup`. */
    ledgerDir?: string;
    /** `BUN_SPAWN_CLEANUP_DARWIN_LINEAGE_MS`: owner-side lineage snapshot interval in ms, default 250, `0` off. */
    lineageMs?: number;
    /** `BUN_SPAWN_CLEANUP_DARWIN_NO_ORPHANS`: also set Bun's NO_ORPHANS flag on every spawn. */
    noOrphans?: boolean;
  };
}

export interface CleanupBackend {
  readonly name: string;
  readonly platform: Platform;
  readonly guarantee: Guarantee;

  /**
   * Put the CURRENT process (and therefore every future descendant) under the
   * backend's containment. Called once by `configureSpawnCleanup()` (which the root entry
   * runs at import). Idempotent and memoized: later calls return the first result and
   * ignore `options`. Never throws.
   *
   * Also ADOPTS the process's existing descendants, best-effort: whatever the platform can
   * enumerate under this pid at setup (toolhelp snapshot, `/proc` parent links, lineage
   * ids) is assigned into the job / cgroup / ledger, so "spawned before setup" stops
   * mattering wherever the platform can make it stop mattering. A descendant that already
   * daemonized out of the parent chain is missed.
   */
  ensure(options?: CleanupOptions): CleanupStatus;

  /**
   * Current status, READ-ONLY: never sets anything up. Before `ensure()` has run it reports
   * `active: false` with reason `not configured`.
   */
  status(): CleanupStatus;

  /**
   * Called right after `Bun.spawn` returns, so the backend can attach per-process
   * tracking (e.g. a nested Job Object) used by `killTree`. Must never throw.
   */
  track(proc: SpawnedProcess): void;

  /**
   * Terminate `pid` and every descendant it has, or had, as far as the backend can
   * see. Returns `tracked: false` when the backend has no handle on that pid, or the
   * kill failed, in which case the caller should fall back to a plain kill.
   */
  killTree(pid: number): KillTreeResult;

  /**
   * Terminate every descendant of THIS process the backend can see, leaving this process
   * alive: the owner's own job / cgroup / lineage minus the owner. Also reaches
   * grandchildren that slipped out of a child's nested group before per-spawn tracking
   * attached. Returns `tracked: false` when the backend has no process-wide handle.
   */
  killAll(): KillTreeResult;

  /**
   * Whether `pid` is inside this process's containment. `undefined` when the backend
   * cannot tell (no containment, process gone, access denied).
   */
  isContained(pid: number): boolean | undefined;

  /**
   * Optional. Environment variables every `spawn()`ed child must carry, e.g. an inherited
   * marker that a best-effort backend later scans for. `spawn()` merges them over the
   * caller's `env` (or over `process.env` when the caller gave none). Return `undefined`
   * when the backend needs nothing, which keeps `spawn()` byte-for-byte `Bun.spawn`.
   */
  spawnEnv?(): Record<string, string> | undefined;
}

/** Shared env escape hatch so tests can prove the mechanism is load-bearing. */
export const DISABLE_ENV = "BUN_SPAWN_CLEANUP_DISABLE";

/** Parse a boolean env knob: unset/empty is `undefined`; `0` and `false` (any case) are false; anything else is true. */
export function envFlag(name: string): boolean | undefined {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Is containment disabled, by option or by env? Returns the reason string when it is, so
 * every backend reports the same wording, else `undefined`. The option wins when both are set.
 */
export function disabledBy(options: CleanupOptions | undefined): string | undefined {
  if (options?.disable !== undefined) return options.disable ? "disabled by option `disable: true`" : undefined;
  return envFlag(DISABLE_ENV) ? `${DISABLE_ENV} is set` : undefined;
}
