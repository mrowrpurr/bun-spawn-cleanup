/**
 * A scenario is one way for child.ts to launch leaf.ts. Each platform contributes its own
 * set in a sibling file (windows.ts, linux.ts, darwin.ts); common.ts has the portable ones.
 *
 * Return "leaf-expected" when the launch should have produced a running leaf (child.ts then
 * waits for the pidfile and prints `LEAF <pid>`), or "no-leaf" when the launch was expected
 * to be refused (print the evidence yourself with `say`, e.g. `BREAKAWAY {...}`).
 */
export interface ScenarioContext {
  /** Absolute path of the bun executable running child.ts. */
  bun: string;
  /** Absolute path of leaf.ts. */
  leaf: string;
  /** Pidfile the leaf will write; its directory is a scratch dir the test owns. */
  pidfile: string;
  /** Print one event line to the owner (and so to the test). */
  say: (line: string) => void;
}

export type ScenarioOutcome = "leaf-expected" | "no-leaf";
export type Scenario = (ctx: ScenarioContext) => Promise<ScenarioOutcome>;
export type ScenarioMap = Record<string, Scenario>;

/** Shell-quote with double quotes (Windows cmd/PowerShell style). */
export const q = (s: string) => `"${s}"`;
