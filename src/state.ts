/**
 * Process-wide state shared by every copy of this library in the process: which backend
 * was selected and whether (and from which entry) `configureSpawnCleanup()` has run.
 *
 * Lives on `globalThis` under `Symbol.for` keys so duplicate copies in `node_modules` and
 * `bun --hot` reloads see one backend and one flag. A second instance would otherwise create
 * a second job / cgroup and the "configure once" rule would be unenforceable.
 *
 * Scope: one JS realm. A `Worker` has its own `globalThis` and its own `Symbol.for`
 * registry, so a Worker that imports the root entry configures again (on Windows and Linux
 * that is a second, nested containment of the same process: harmless, redundant) and a
 * Worker that imports `/core` must call `configureSpawnCleanup()` itself before `spawn()`.
 * The macOS backend owns per thread by design. Prefer spawning from the main thread.
 *
 * Nothing in this module has a side effect at import. Selecting a backend only picks an
 * object; `ensure()` is what touches the OS, and only `configure*()` below calls it.
 *
 * Not a package export: `core.ts` and `internal.ts` are the only importers.
 */
import type { CleanupBackend, CleanupOptions, CleanupStatus } from "./backend.ts";
import { createDarwinBackend } from "./platform/darwin/index.ts";
import { createLinuxBackend } from "./platform/linux/index.ts";
import { noopBackend } from "./platform/noop.ts";
import { createWindowsBackend } from "./platform/windows/index.ts";

/** Which entry ran setup. `undefined` until one does. */
export type ConfiguredBy = "root" | "core";

const BACKEND_KEY = Symbol.for("bun-spawn-cleanup/backend");
const CONFIGURED_KEY = Symbol.for("bun-spawn-cleanup/configured");
const g = globalThis as unknown as Record<symbol, unknown>;

const PREFIX = "bun-spawn-cleanup:";
export const ERR_NOT_CONFIGURED =
  `${PREFIX} spawn() called before configureSpawnCleanup(). Call it first, or import "bun-spawn-cleanup" (not "/core") to have it run at import.`;
export const ERR_ALREADY_RAN = `${PREFIX} configureSpawnCleanup() already ran; it is one-shot and irreversible.`;
export const ERR_ALREADY_RAN_BY_ROOT =
  `${PREFIX} configureSpawnCleanup() already ran (importing "bun-spawn-cleanup" does it for you; import "bun-spawn-cleanup/core" everywhere if you want to choose the moment).`;
export const ERR_ROOT_AFTER_CORE =
  `${PREFIX} configureSpawnCleanup() already ran from "bun-spawn-cleanup/core"; do not also import "bun-spawn-cleanup" (the root entry configures at import).`;

function selectBackend(): CleanupBackend {
  switch (process.platform) {
    case "win32":
      return createWindowsBackend();
    case "linux":
      return createLinuxBackend();
    case "darwin":
      return createDarwinBackend();
    default:
      return noopBackend("other", `unsupported platform ${process.platform}`);
  }
}

/** The one backend for this process. Selecting it has no side effect. */
export function currentBackend(): CleanupBackend {
  return (g[BACKEND_KEY] as CleanupBackend | undefined) ?? ((g[BACKEND_KEY] = selectBackend()) as CleanupBackend);
}

export function configuredBy(): ConfiguredBy | undefined {
  return g[CONFIGURED_KEY] as ConfiguredBy | undefined;
}

export function isConfigured(): boolean {
  return configuredBy() !== undefined;
}

/** `configureSpawnCleanup()` as called by user code through the `/core` entry. */
export function configureFromCore(options: CleanupOptions | undefined): CleanupStatus {
  const by = configuredBy();
  if (by === "root") throw new Error(ERR_ALREADY_RAN_BY_ROOT);
  if (by !== undefined) throw new Error(ERR_ALREADY_RAN);
  g[CONFIGURED_KEY] = "core";
  return currentBackend().ensure(options);
}

/**
 * Setup as run by the root entry at import. A second root import (duplicate copy,
 * `bun --hot` reload) is a no-op; a root import after `/core` already configured throws,
 * so the two styles cannot be mixed by accident.
 */
export function configureFromRoot(): CleanupStatus {
  const by = configuredBy();
  if (by === "root") return currentBackend().status();
  if (by !== undefined) throw new Error(ERR_ROOT_AFTER_CORE);
  g[CONFIGURED_KEY] = "root";
  return currentBackend().ensure();
}
