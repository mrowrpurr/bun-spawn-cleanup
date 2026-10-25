/**
 * bun-spawn-cleanup/internal — diagnostics for this library's own tests and for anyone
 * debugging a backend. Not part of the supported API; shapes may change without notice.
 * Importing it has no side effect.
 */
import type { CleanupBackend } from "./backend.ts";
import { configuredBy, currentBackend, isConfigured } from "./state.ts";
export { configuredBy, isConfigured };

export type { CleanupBackend, SpawnedProcess } from "./backend.ts";
export { DISABLE_ENV } from "./backend.ts";

/** The backend selected for this platform. Selecting it has no side effect. */
export const backend: CleanupBackend = currentBackend();

/**
 * Is `pid` inside this process's containment? `undefined` when the backend cannot tell, or
 * when `configureSpawnCleanup()` has not run (asking would otherwise set up lazily).
 */
export function isContained(pid: number): boolean | undefined {
  return isConfigured() ? backend.isContained(pid) : undefined;
}

