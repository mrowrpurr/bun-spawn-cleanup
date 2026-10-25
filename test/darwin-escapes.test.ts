/**
 * macOS known escapes, asserted AS escapes so a behavior change is noticed (same idea as the
 * WMI test on Windows). Neither can be closed without privilege.
 *
 * F: fast double fork + setsid + env -i. Lineage links a process to its creator's unique id;
 *    the intermediate lives for microseconds and dies before any scan sees it (zombies report
 *    no ids, and NOTE_TRACK, which let kqueue follow forks, is gone since 10.5), so the chain
 *    is broken; env -i removed the marker; setsid left the process group. Run without the
 *    daemon so the owner's 250 ms timer is the only tracker and the outcome is deterministic.
 *    With the daemon, NOTE_FORK narrows the window to its reaction time but cannot close it.
 * Not an escape, asserted too: `open -n -a <bundle>` (LaunchServices). launchd forks the app,
 *    so lineage and the process group miss it, but `open` hands the caller's environment to
 *    the app, so the marker still finds it.
 * G: broker launch. `launchctl submit` asks launchd to fork the leaf: launchd's child, with
 *    launchd's env. The same holds for `open`, ssh, cron, XPC services, and for
 *    Task Scheduler/WMI on Windows and systemd-run on Linux.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { launchctlLabel } from "./fixtures/scenarios/darwin.ts";
import { disposeLedgerDir, IS_DARWIN, ownerEnv, darwinPidfile, reapStrays, runCli, scratchLedgerDir, waitForArmed } from "./darwin-helpers.ts";
import { aliveAfter, hardKill, pidAlive, reapAll, sleep, startOwner, trackLeaf, waitForLeaf } from "./helpers.ts";
import { shortInfo, uniqueIds } from "../src/platform/darwin/ffi.ts";

const T = 60_000;
const d = IS_DARWIN ? describe : describe.skip;
let dir = "";

beforeAll(() => {
  if (IS_DARWIN) dir = scratchLedgerDir();
});
afterEach(async () => {
  if (IS_DARWIN) reapStrays(); // removes launchd jobs first, else KeepAlive respawns the leaf
  await reapAll();
});
afterAll(() => {
  if (IS_DARWIN) disposeLedgerDir(dir);
});

d("darwin: known escapes", () => {
  test("ESCAPE F: fast double fork + setsid + env -i is not contained and survives SIGKILL and the sweep", async () => {
    const run = await startOwner({ scenario: "fast-double-fork-env-strip", pidfile: darwinPidfile(), env: ownerEnv(dir, "off") });
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(false);
    await hardKill(run.ownerPid);
    runCli(dir, "sweep");
    await sleep(1_500);
    expect(pidAlive(leaf.pid)).toBe(true);
  }, T);

  test("CONTROL F: the same tree minus env -i is caught by the marker", async () => {
    const run = await startOwner({ scenario: "double-fork", pidfile: darwinPidfile(), env: ownerEnv(dir, "off") });
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true);
    await hardKill(run.ownerPid);
    runCli(dir, "sweep");
    expect(await aliveAfter(leaf.pid, 3_000)).toBe(false);
  }, T);

  const hasLaunchctl = IS_DARWIN && !!Bun.which("launchctl");
  (hasLaunchctl ? test : test.skip)(
    "ESCAPE G: a leaf started through `launchctl submit` is launchd's child and survives the owner's SIGKILL with the daemon serving",
    async () => {
      const pidfile = darwinPidfile();
      const run = await startOwner({ scenario: "launchctl", pidfile, env: ownerEnv(dir, "auto") });
      const label = (await run.waitFor(/^LAUNCHCTL (\S+)$/))[1]!;
      expect(label).toBe(launchctlLabel(pidfile));
      const leaf = await waitForLeaf(run);
      expect(leaf.contained).toBe(false);
      await hardKill(run.ownerPid);
      expect(await aliveAfter(run.childPid, 5_000)).toBe(false); // the daemon did act
      expect(pidAlive(leaf.pid)).toBe(true);
    },
    T,
  );

  test("NOT an escape: `open -n -a` of a throwaway .app is launchd's child but inherits the marker, and dies on owner SIGKILL", async () => {
    const run = await startOwner({ scenario: "open-a", pidfile: darwinPidfile(), env: ownerEnv(dir, "auto") });
    const m = await run.waitFor(/^(?:LEAF (\d+) contained=(\w+)|SKIP (.*))$/, 45_000);
    if (m[3]) {
      console.warn(`darwin open -a test skipped: ${m[3]}`);
      return;
    }
    const leaf = Number(m[1]);
    trackLeaf(leaf);
    expect(m[2]).toBe("true"); // by marker:
    expect(uniqueIds(leaf)!.puid).toBe(uniqueIds(1)!.uid); // created by launchd, so no lineage
    expect(shortInfo(leaf)!.pgid).toBe(leaf); // own process group
    expect(await waitForArmed(dir, run.ownerPid)).toBe(true);
    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf, 5_000)).toBe(false);
  }, T);
});
