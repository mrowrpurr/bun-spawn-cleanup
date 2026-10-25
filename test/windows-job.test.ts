/**
 * Windows Job Object backend: containment and reaping.
 *
 * Tree:  bun test -> owner.ts (library) -> child.ts -> [launcher] -> leaf.ts
 *
 * Every "reaped" test hard-kills the OWNER with `taskkill /F /PID` (no /T), so no cleanup
 * code in the owner ever runs; only the kernel's kill-on-close can save us. The control
 * tests run the same trees with BUN_SPAWN_CLEANUP_DISABLE=1 and assert the leaf SURVIVES,
 * which is what proves the job is doing the work and not Bun's own child handling.
 *
 * Note on controls: Bun already reaps a DIRECT child of a Bun process on a hard kill, so a
 * leaf spawned via plain `Bun.spawn` is not a useful control. The controls use `detached`,
 * `cmd start /b`, and PowerShell `Start-Process`, which all leak without the job.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  aliveAfter,
  hardKill,
  IS_WINDOWS,
  pidAlive,
  reapAll,
  sleep,
  startOwner,
  tempPidfile,
  waitForLeaf,
} from "./helpers.ts";

const T = 60_000;
const d = IS_WINDOWS ? describe : describe.skip;

afterEach(async () => {
  await reapAll();
});

d("windows job object: status", () => {
  test("owner reports an active kernel guarantee", async () => {
    const run = await startOwner({ scenario: "bun", pidfile: tempPidfile() });
    expect(run.status).toMatchObject({ active: true, guarantee: "kernel" });
    expect(run.childContained).toBe(true);
    await waitForLeaf(run);
  }, T);

  test("BUN_SPAWN_CLEANUP_DISABLE=1 turns the job off and says why", async () => {
    const run = await startOwner({ scenario: "bun", pidfile: tempPidfile(), disable: true });
    expect(run.status.active).toBe(false);
    expect(run.status.reason).toContain("BUN_SPAWN_CLEANUP_DISABLE");
    expect(run.childContained).toBeUndefined();
    await waitForLeaf(run);
  }, T);
});

d("windows job object: descendants are contained and reaped on hard kill", () => {
  const scenarios: Array<[string, string]> = [
    ["bun", "grandchild via Bun.spawn"],
    ["detached", "grandchild via Bun.spawn({ detached: true })"],
    ["cmd-start", "great-grandchild via cmd.exe `start /b` (cmd exits immediately)"],
    ["ps-start-process", "great-grandchild via PowerShell Start-Process"],
  ];

  for (const [scenario, label] of scenarios) {
    test(`${label}: in job, dies when owner is taskkill /F'd`, async () => {
      const run = await startOwner({ scenario, pidfile: tempPidfile() });
      const leaf = await waitForLeaf(run);
      expect(leaf.contained).toBe(true);
      expect(pidAlive(leaf.pid)).toBe(true);

      await hardKill(run.ownerPid);
      expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
      expect(await aliveAfter(run.childPid, 1_000)).toBe(false);
    }, T);
  }

  test("grandchild whose parent already exited (reparented orphan) still dies with the owner", async () => {
    const run = await startOwner({ scenario: "cmd-start", pidfile: tempPidfile(), childMode: "exit" });
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true);
    // child.ts exits right after the leaf is up; the leaf is now parented to nobody useful.
    expect(await aliveAfter(run.childPid, 5_000)).toBe(false);
    expect(pidAlive(leaf.pid)).toBe(true);

    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);
});

d("windows job object: other owner termination paths", () => {
  test("clean process.exit(0) reaps the tree", async () => {
    const run = await startOwner({ scenario: "cmd-start", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    run.send("exit");
    expect(await run.proc.exited).toBe(0);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);

  test("uncaught exception in the owner reaps the tree", async () => {
    const run = await startOwner({ scenario: "cmd-start", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    run.send("throw");
    expect(await run.proc.exited).not.toBe(0);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);

  test("Stop-Process -Force on the owner reaps the tree", async () => {
    const run = await startOwner({ scenario: "detached", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    const ps = Bun.spawn(
      ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Force -Id ${run.ownerPid}`],
      { stdout: "ignore", stderr: "ignore" },
    );
    await ps.exited;
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);
});

d("windows job object: killTree", () => {
  test("killTree(child) kills the child's subtree and leaves the owner alive", async () => {
    const run = await startOwner({ scenario: "cmd-start", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    await run.waitFor(/^READY$/);

    run.send("killtree");
    const m = await run.waitFor(/^KILLTREE (.*)$/);
    expect(JSON.parse(m[1]!)).toMatchObject({ tracked: true });

    expect(await aliveAfter(run.childPid, 5_000)).toBe(false);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);

    run.send("exit");
    await run.proc.exited;
  }, T);

  test("killTree(child) still reaches a grandchild after the child itself has exited", async () => {
    const run = await startOwner({ scenario: "cmd-start", pidfile: tempPidfile(), childMode: "exit" });
    const leaf = await waitForLeaf(run);
    expect(await aliveAfter(run.childPid, 5_000)).toBe(false); // child gone, leaf orphaned
    expect(pidAlive(leaf.pid)).toBe(true);

    run.send("killtree");
    const m = await run.waitFor(/^KILLTREE (.*)$/);
    expect(JSON.parse(m[1]!)).toMatchObject({ tracked: true });
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);

    run.send("exit");
    await run.proc.exited;
  }, T);
});

d("windows job object: CONTROL (job disabled) proves the job is load-bearing", () => {
  const scenarios: Array<[string, string]> = [
    ["detached", "Bun.spawn({ detached: true })"],
    ["cmd-start", "cmd.exe `start /b`"],
    ["ps-start-process", "PowerShell Start-Process"],
  ];

  for (const [scenario, label] of scenarios) {
    test(`${label}: WITHOUT the job the leaf survives the owner's hard kill`, async () => {
      const run = await startOwner({ scenario, pidfile: tempPidfile(), disable: true });
      const leaf = await waitForLeaf(run);
      expect(pidAlive(leaf.pid)).toBe(true);

      await hardKill(run.ownerPid);
      await sleep(1_500);
      expect(pidAlive(leaf.pid)).toBe(true); // orphaned, leaked: this is the bug the library fixes
    }, T);
  }
});
