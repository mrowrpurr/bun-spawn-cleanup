/** Portable scenarios: valid on every platform. */
import type { ScenarioMap } from "./types.ts";

export const common: ScenarioMap = {
  // Plain Bun.spawn: the ordinary case.
  async bun({ bun, leaf, pidfile }) {
    Bun.spawn([bun, leaf, pidfile], { stdio: ["ignore", "ignore", "ignore"] });
    return "leaf-expected";
  },

  // Bun's `detached` flag (new process group / session on POSIX, DETACHED_PROCESS-style on
  // Windows). Must not escape the owner's containment.
  async detached({ bun, leaf, pidfile }) {
    const p = Bun.spawn([bun, leaf, pidfile], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
    p.unref();
    return "leaf-expected";
  },
};
