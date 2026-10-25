/**
 * child.ts <scenario> <pidfile> <stay|exit>
 *
 * The direct child of the owner. Launches `leaf.ts <pidfile>` through the mechanism named by
 * <scenario>, which is where the escape attempts live (see ./scenarios/*.ts). Prints one line
 * per event so the owner (and through it the test) can follow along:
 *
 *   LAUNCHED <scenario>             leaf launch requested
 *   LEAF <pid>                      leaf wrote its pidfile
 *   READY                           done launching; now staying or exiting
 *   ERROR <message>
 *   <scenario-specific lines>       e.g. BREAKAWAY {...}, WMI <rv> <pid>
 *
 * With `exit` as the third argument the child exits right after the leaf is up, so the
 * leaf is orphaned (reparented) before the owner dies. With `stay` it lives forever.
 */
import { join } from "node:path";
import { common } from "./scenarios/common.ts";
import { darwin } from "./scenarios/darwin.ts";
import { linux } from "./scenarios/linux.ts";
import type { ScenarioMap } from "./scenarios/types.ts";
import { windows } from "./scenarios/windows.ts";

const scenario = process.argv[2] ?? "";
const pidfile = process.argv[3] ?? "";
const mode = process.argv[4] ?? "stay";
if (!scenario || !pidfile) {
  console.error("usage: child.ts <scenario> <pidfile> <stay|exit>");
  process.exit(2);
}

function say(line: string): void {
  process.stdout.write(line + "\n");
}

const platformScenarios: ScenarioMap =
  process.platform === "win32" ? windows : process.platform === "linux" ? linux : process.platform === "darwin" ? darwin : {};
const scenarios: ScenarioMap = { ...common, ...platformScenarios };

const run = scenarios[scenario];
if (!run) {
  say(`ERROR unknown scenario ${scenario} on ${process.platform}`);
  process.exit(2);
}

async function waitForLeafPid(timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = Bun.file(pidfile);
    if (await f.exists()) {
      const text = (await f.text()).trim();
      if (/^\d+$/.test(text)) return Number(text);
    }
    await Bun.sleep(50);
  }
  return undefined;
}

say(`LAUNCHED ${scenario}`);
const expectation = await run({ bun: process.execPath, leaf: join(import.meta.dir, "leaf.ts"), pidfile, say });
if (expectation === "leaf-expected") {
  const pid = await waitForLeafPid(20_000);
  if (pid === undefined) say("ERROR leaf pidfile never appeared");
  else say(`LEAF ${pid}`);
}
say("READY");

if (mode === "exit") process.exit(0);
setInterval(() => {}, 60_000);
