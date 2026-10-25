/**
 * bun-spawn-cleanup/core — the same API as the root entry, with no side effect at import.
 *
 *   import { configureSpawnCleanup, spawn, killTree, status } from "bun-spawn-cleanup/core";
 *
 *   if (!cli.noCleanup) configureSpawnCleanup({ linux: { landlock: false } });
 *   const proc = spawn(["git", "status"]);
 *
 * `configureSpawnCleanup()` is the setup: one-shot, irreversible, called where the program
 * chooses. Until it runs, `spawn()` throws, so a program cannot start children thinking they
 * are contained when they are not. Importing the root entry ("bun-spawn-cleanup") anywhere in
 * the module graph runs it at import; mixing the two styles throws (see `state.ts`).
 *
 * Why irreversible: a process cannot leave a Windows job, and Landlock forbids leaving the
 * cgroup. The API must not imply a pair, so there is no `stop()`.
 */
import type { CleanupOptions, CleanupStatus, KillTreeResult } from "./backend.ts";
import { configureFromCore, currentBackend, ERR_NOT_CONFIGURED, isConfigured } from "./state.ts";

export type {
  CleanupOptions,
  CleanupStatus,
  Guarantee,
  KillTreeResult,
  Platform,
} from "./backend.ts";

/**
 * Put THIS process under containment so every descendant it ever creates, by any API, dies
 * with it. Runs once per process; a second call throws. Options are read here and never
 * again; each one mirrors an env var and wins over it when both are set. Never throws for
 * OS-level failure: a backend that cannot set up reports `active: false` with a reason and
 * `spawn()` degrades to plain `Bun.spawn`. Returns the same thing `status()` would.
 */
export function configureSpawnCleanup(options: CleanupOptions = {}): CleanupStatus {
  return configureFromCore(options);
}

/**
 * READ-ONLY status: which backend, what guarantee, and whether it is active, with the
 * reason when it is not. Correct from the moment `configureSpawnCleanup()` ran; before
 * that it reports `active: false, reason: "not configured ..."`.
 */
export function status(): CleanupStatus {
  return currentBackend().status();
}

/**
 * Drop-in for `Bun.spawn`, same overloads and return type. Throws if
 * `configureSpawnCleanup()` has not run. Spawns, then attaches per-process tracking so
 * `killTree` can reach the subtree.
 */
export const spawn: typeof Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  if (!isConfigured()) throw new Error(ERR_NOT_CONFIGURED);
  const backend = currentBackend();
  const extra = backend.spawnEnv?.();
  const proc = (Bun.spawn as (...a: unknown[]) => Bun.Subprocess)(...(extra ? withEnv(args, extra) : args));
  backend.track(proc);
  return proc;
}) as typeof Bun.spawn;

/**
 * Merge backend-required env vars into either `Bun.spawn` overload: `(cmd, options?)` or
 * `({ cmd, ...options })`. Only used when the backend asked for something (today: the Linux
 * best-effort marker); otherwise the arguments reach `Bun.spawn` untouched.
 */
function withEnv(args: Parameters<typeof Bun.spawn>, extra: Record<string, string>): Parameters<typeof Bun.spawn> {
  const merge = (opts: { env?: Record<string, string | undefined> }) => ({
    ...opts,
    env: { ...(opts.env ?? process.env), ...extra },
  });
  const [first, second] = args as [unknown, unknown];
  const out: unknown[] = Array.isArray(first)
    ? [first, merge((second ?? {}) as { env?: Record<string, string | undefined> })]
    : [merge(first as { env?: Record<string, string | undefined> })];
  return out as unknown as Parameters<typeof Bun.spawn>;
}

/**
 * Kill `proc` and every descendant the backend can see, including descendants that
 * outlived `proc` itself, while this process keeps running. Falls back to `proc.kill()` on
 * the direct child when the backend has no tree handle for it, the tree kill failed, or
 * `configureSpawnCleanup()` never ran.
 *
 * With NO argument: kill every descendant of this process and leave this process alive.
 * On Windows and Linux/cgroup that is the owner's own job / cgroup minus the owner, which
 * also catches grandchildren that slipped out of a child's nested group in the microseconds
 * before tracking attached.
 */
export function killTree(proc?: Bun.Subprocess | number): KillTreeResult {
  // Never let killTree be the thing that configures the process: the backends set up
  // lazily when asked for a tree handle, and that is a side effect the caller did not ask for.
  if (proc === undefined) return isConfigured() ? currentBackend().killAll() : { tracked: false, detail: "not configured" };
  const pid = typeof proc === "number" ? proc : proc.pid;
  const result = isConfigured() ? currentBackend().killTree(pid) : { tracked: false, detail: "not configured" };
  if (!result.tracked && typeof proc !== "number") {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
  return result;
}
