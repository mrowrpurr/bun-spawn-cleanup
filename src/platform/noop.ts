import type { CleanupBackend, CleanupStatus, Platform } from "../backend.ts";

/**
 * Passthrough backend for platforms with no implementation yet. `spawn` behaves exactly
 * like `Bun.spawn`; `killTree` reports `tracked: false` so the caller falls back to a
 * plain `kill()` of the direct child. Options are accepted and ignored: nothing to configure.
 */
export function noopBackend(platform: Platform, reason: string): CleanupBackend {
  const status: CleanupStatus = { platform, backend: "noop", guarantee: "none", active: false, reason };
  return {
    name: "noop",
    platform,
    guarantee: "none",
    ensure: () => status,
    status: () => status,
    track: () => {},
    killTree: () => ({ tracked: false, detail: reason }),
    killAll: () => ({ tracked: false, detail: reason }),
    isContained: () => undefined,
  };
}
