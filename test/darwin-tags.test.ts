/**
 * macOS: every scenario's leaf is tagged (lineage, marker, or both), and dies within 5 s of
 * the owner being SIGKILLed while the daemon serves the ledger directory. Each scenario has a
 * BUN_SPAWN_CLEANUP_DISABLE=1 CONTROL in which the leaf must SURVIVE: Bun does not reap its
 * children when killed on macOS (probed), so a dead leaf in a control would mean the scenario
 * tests nothing.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { BACKEND_NAME, MARKER_ENV } from "../src/platform/darwin/index.ts";
import { procEnv } from "../src/platform/darwin/ffi.ts";
import { markerSegments } from "../src/platform/darwin/procs.ts";
import { disposeLedgerDir, IS_DARWIN, ownerEnv, darwinPidfile, reapStrays, scratchLedgerDir, waitForArmed, waitForDaemon } from "./darwin-helpers.ts";
import { aliveAfter, hardKill, pidAlive, reapAll, startOwner, waitForLeaf } from "./helpers.ts";

const T = 60_000;
const d = IS_DARWIN ? describe : describe.skip;
let dir = "";

beforeAll(() => {
  if (IS_DARWIN) dir = scratchLedgerDir();
});
afterEach(async () => {
  await reapAll();
  if (IS_DARWIN) reapStrays();
});
afterAll(() => {
  if (IS_DARWIN) disposeLedgerDir(dir);
});

const start = (scenario: string, disable = false) =>
  startOwner({ scenario, pidfile: darwinPidfile(), disable, env: ownerEnv(dir, "auto") });

d("darwin: status and tags", () => {
  test("owner reports an active best-effort guarantee and a serving daemon", async () => {
    const run = await start("bun");
    expect(run.status).toMatchObject({ active: true, guarantee: "best-effort", backend: BACKEND_NAME });
    expect(run.status.reason).toMatch(/daemon (started|running) \(pid \d+\)/);
    expect(await waitForDaemon(dir)).toBeDefined();
    expect(run.childContained).toBe(true);
    expect((await waitForLeaf(run)).contained).toBe(true);
  }, T);

  test("the marker is in the child's environment, keyed by the owner", async () => {
    const run = await start("bun");
    const env = procEnv(run.childPid) ?? [];
    expect(env.some((e) => e.startsWith(`${MARKER_ENV}=${run.ownerPid}-`))).toBe(true);
    await waitForLeaf(run);
  }, T);
});

d("darwin: reading the marker back", () => {
  // KERN_PROCARGS2 pads the exec path to a multiple of 8; an empty argv[0] used to be taken
  // for padding, shifting the first env entry into argv.
  test("the marker is found when argv[0] is empty and the marker is the first env entry", async () => {
    const p = Bun.spawn(["perl", "-e", 'exec { $ARGV[0] } "", "30"', "/bin/sleep"], {
      env: { [MARKER_ENV]: "1-2-3", OTHER: "x" },
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      let segs: string[] | undefined;
      for (let i = 0; i < 40 && !segs?.length; i++) {
        await Bun.sleep(25);
        segs = markerSegments(p.pid);
      }
      expect(segs).toEqual(["1-2-3"]);
    } finally {
      p.kill("SIGKILL");
    }
  }, T);
});

d("darwin: owner SIGKILL with the daemon serving reaps every scenario", () => {
  const scenarios: Array<[string, string]> = [
    ["bun", "grandchild via Bun.spawn"],
    ["detached", "grandchild via Bun.spawn({ detached: true })"],
    ["setsid", "grandchild in a new session (perl POSIX::setsid)"],
    ["nohup-bg", "great-grandchild via `sh -c 'nohup ... &'` (sh exits at once)"],
    ["double-fork", "great-great-grandchild via double fork"],
    ["env-strip", "grandchild with env -i AND setsid (lineage only)"],
    ["bun-child", "non-Bun leaf under a Bun intermediate"],
  ];

  for (const [scenario, label] of scenarios) {
    test(`${label}: contained, dies when the owner is SIGKILLed`, async () => {
      const run = await start(scenario);
      const leaf = await waitForLeaf(run);
      expect(leaf.contained).toBe(true);
      expect(await waitForDaemon(dir)).toBeDefined();
      expect(await waitForArmed(dir, run.ownerPid)).toBe(true);
      await hardKill(run.ownerPid);
      expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
      expect(await aliveAfter(run.childPid, 1_000)).toBe(false);
    }, T);

    test(`CONTROL ${scenario}: with ${"BUN_SPAWN_CLEANUP_DISABLE"}=1 the leaf survives the owner's SIGKILL`, async () => {
      const run = await start(scenario, true);
      expect(run.status.active).toBe(false);
      const leaf = await waitForLeaf(run);
      await hardKill(run.ownerPid);
      expect(await aliveAfter(leaf.pid, 2_000)).toBe(true);
      expect(pidAlive(run.childPid)).toBe(true);
    }, T);
  }
});
