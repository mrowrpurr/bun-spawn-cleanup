/**
 * CONTROLS for both Linux suites: the same trees with BUN_SPAWN_CLEANUP_DISABLE=1 must
 * LEAK, or the scenario is not testing anything. Unlike Windows, Bun on Linux does nothing
 * special for a direct child when its parent is SIGKILLed (the kernel never kills children
 * on parent death), so even plain `Bun.spawn` is a valid control here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { hardKill, pidAlive, reapAll, sleep, startOwner, tempPidfile, waitForLeaf } from "./helpers.ts";
import { IS_LINUX } from "./linux-helpers.ts";

const T = 60_000;
const d = IS_LINUX ? describe : describe.skip;

afterEach(async () => {
  await reapAll();
});

d("linux CONTROL (cleanup disabled) proves the mechanism is load-bearing", () => {
  const scenarios: Array<[string, string]> = [
    ["bun", "Bun.spawn"],
    ["detached", "Bun.spawn({ detached: true })"],
    ["setsid", "setsid"],
    ["nohup-bg", "sh -c 'nohup ... &'"],
    ["double-fork", "double fork"],
    ["disown", "bash & disown"],
    ["env-strip", "env -i"],
  ];

  for (const [scenario, label] of scenarios) {
    test(`${label}: WITHOUT cleanup the leaf survives the owner's SIGKILL`, async () => {
      const run = await startOwner({ scenario, pidfile: tempPidfile(), disable: true });
      expect(run.status.active).toBe(false);
      const leaf = await waitForLeaf(run);
      expect(pidAlive(leaf.pid)).toBe(true);

      await hardKill(run.ownerPid);
      await sleep(1_500);
      expect(pidAlive(leaf.pid)).toBe(true); // orphaned, leaked: this is the bug the library fixes
    }, T);
  }
});
