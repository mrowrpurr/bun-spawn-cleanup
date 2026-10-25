/**
 * macOS: what happens after a death the owner cannot see (SIGKILL, jetsam, native crash).
 *
 * Without the daemon the ledger is the only trace: the leaf survives until the next owner's
 * `ensure()` or `bun-spawn-cleanup sweep` finds the stale ledger and kills its tree. With the
 * daemon it is immediate (darwin-tags.test.ts); here: the daemon is a singleton, hides "bun"
 * from its command line, is restarted by a live owner after something kills it, and sweeps
 * on start. Bun's own NO_ORPHANS flag is opt-in, and pinned here both for what it covers and
 * for the side effect that keeps it opt-in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_ORPHANS_ENV, TEST_IDLE_ENV } from "../src/platform/darwin/index.ts";
import { TEST_FAIL_ENV } from "../src/platform/darwin/daemon.ts";
import { bootSessionId, uniqueIds } from "../src/platform/darwin/ffi.ts";
import { DAEMON_FILE, ledgerPath, liveDaemon, probeDaemonLock, writeLedger } from "../src/platform/darwin/ledger.ts";
import { existsSync } from "node:fs";
import {
  disposeLedgerDir,
  IS_DARWIN,
  ledgerFiles,
  LINEAGE_MS_ENV,
  ownerEnv,
  darwinPidfile,
  reapStrays,
  runCli,
  scratchLedgerDir,
  stopDaemon,
  waitForArmed,
  waitForDaemon,
} from "./darwin-helpers.ts";
import { aliveAfter, hardKill, pidAlive, reapAll, startOwner, waitForLeaf } from "./helpers.ts";

const T = 60_000;
const d = IS_DARWIN ? describe : describe.skip;
let off = ""; // never served by a daemon
let auto = ""; // daemon on

beforeAll(() => {
  if (!IS_DARWIN) return;
  off = scratchLedgerDir();
  auto = scratchLedgerDir();
});
afterEach(async () => {
  await reapAll();
  if (IS_DARWIN) reapStrays();
});
afterAll(() => {
  if (!IS_DARWIN) return;
  disposeLedgerDir(off);
  disposeLedgerDir(auto);
});

const startOff = (scenario: string, extra: Record<string, string> = {}, childMode: "stay" | "exit" = "stay") =>
  startOwner({ scenario, pidfile: darwinPidfile(), env: ownerEnv(off, "off", extra), childMode });
const startAuto = (scenario: string, extra: Record<string, string> = {}) =>
  startOwner({ scenario, pidfile: darwinPidfile(), env: ownerEnv(auto, "auto", extra) });

d("darwin: no daemon, SIGKILL, then sweep", () => {
  test("SIGKILL leaves the leaf alive and the ledger behind; the next owner's ensure() sweeps both", async () => {
    const run = await startOff("nohup-bg");
    const leaf = await waitForLeaf(run);
    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(true);
    expect(ledgerFiles(off).some((f) => f.startsWith(`${run.ownerPid}-`))).toBe(true);

    const next = await startOff("bun");
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
    expect(ledgerFiles(off).some((f) => f.startsWith(`${run.ownerPid}-`))).toBe(false);
    next.send("exit");
    await next.proc.exited;
  }, T);

  test("`bun-spawn-cleanup sweep` kills an env-stripped setsid leaf from the ledger's lineage", async () => {
    const run = await startOff("env-strip");
    const leaf = await waitForLeaf(run);
    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 1_000)).toBe(true);
    const r = runCli(off, "sweep");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(new RegExp(`swept owner ${run.ownerPid}-\\d+: killed [1-9]`));
    expect(await aliveAfter(leaf.pid, 3_000)).toBe(false);
    expect(runCli(off, "sweep").out).toContain("nothing to sweep");
  }, T);

  test("`daemon --once` is a sweep", async () => {
    const run = await startOff("double-fork");
    const leaf = await waitForLeaf(run);
    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 1_000)).toBe(true);
    expect(runCli(off, "daemon", "--once").code).toBe(0);
    expect(await aliveAfter(leaf.pid, 3_000)).toBe(false);
    expect(liveDaemon(off)).toBeUndefined();
  }, T);

  test("`status` and `ls` show the live owner and its marked processes", async () => {
    const run = await startOff("nohup-bg");
    const leaf = await waitForLeaf(run);
    const st = runCli(off, "status");
    expect(st.out).toContain("daemon: not running");
    expect(st.out).toMatch(new RegExp(`owner ${run.ownerPid}-\\d+: pid ${run.ownerPid} alive`));
    const ls = runCli(off, "ls");
    expect(ls.out).toMatch(new RegExp(`owner ${run.ownerPid}-\\d+:`));
    expect(ls.out).toContain(`  ${leaf.pid} `);
    run.send("exit");
    await run.proc.exited;
  }, T);
});

d("darwin: stale ledgers from another boot", () => {
  // Unique ids restart at boot, so a ledger written before a reboot names strangers. Built by
  // hand here: a dead "owner" whose lineage holds the unique id of a live sleeper.
  const fakeLedger = async (boot: string) => {
    const sleeper = Bun.spawn(["sleep", "60"], { stdio: ["ignore", "ignore", "ignore"] });
    await Bun.sleep(100);
    const uid = String(uniqueIds(sleeper.pid)!.uid);
    const key = `99999-${uid}0`; // pid 99999 with a unique id nobody has: a dead owner
    writeLedger(ledgerPath(off, key), {
      version: 1,
      owner: { pid: 99999, uid: `${uid}0` },
      marker: key,
      created: Date.now(),
      boot,
      spawns: [],
      lineage: [uid],
      exclude: [],
    });
    return { sleeper, key };
  };

  test("a ledger from another boot is deleted without killing anything", async () => {
    const { sleeper, key } = await fakeLedger("00000000-0000-0000-0000-000000000000");
    try {
      runCli(off, "sweep");
      expect(ledgerFiles(off)).not.toContain(`${key}.json`);
      expect(await aliveAfter(sleeper.pid, 500)).toBe(true);
    } finally {
      sleeper.kill("SIGKILL");
    }
  }, T);

  test("CONTROL: the same ledger stamped with this boot kills its lineage", async () => {
    const { sleeper } = await fakeLedger(bootSessionId()!);
    runCli(off, "sweep");
    expect(await sleeper.exited).not.toBe(0);
  }, T);
});

d("darwin: Bun's NO_ORPHANS flag (opt-in)", () => {
  test(`with ${NO_ORPHANS_ENV}=1 and no daemon, a non-Bun leaf under Bun intermediates dies on owner SIGKILL`, async () => {
    const run = await startOff("bun-child", { [NO_ORPHANS_ENV]: "1" });
    const leaf = await waitForLeaf(run);
    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);

  test("without it (default) the same leaf survives until a sweep", async () => {
    const run = await startOff("bun-child");
    const leaf = await waitForLeaf(run);
    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(true);
    runCli(off, "sweep");
    expect(await aliveAfter(leaf.pid, 3_000)).toBe(false);
  }, T);

  // Why it is opt-in: a Bun process with the flag kills its own direct children when IT
  // exits, so a Bun child that starts a background process and exits loses it while the
  // owner is still alive. If Bun ever changes this, the default can be revisited.
  test(`SIDE EFFECT pinned: with ${NO_ORPHANS_ENV}=1 a Bun child's direct child dies when the Bun child exits normally`, async () => {
    const run = await startOff("bun", { [NO_ORPHANS_ENV]: "1" }, "exit");
    const leaf = await waitForLeaf(run);
    expect(await aliveAfter(run.childPid, 5_000)).toBe(false);
    expect(await aliveAfter(leaf.pid, 3_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);
    run.send("exit");
    await run.proc.exited;
  }, T);

  test("CONTROL: by default that leaf outlives its Bun parent while the owner lives", async () => {
    const run = await startOff("bun", {}, "exit");
    const leaf = await waitForLeaf(run);
    expect(await aliveAfter(run.childPid, 5_000)).toBe(false);
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(true);
    run.send("exit");
    await run.proc.exited;
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(false);
  }, T);
});

d("darwin: the daemon", () => {
  test("is a singleton: a second `daemon` exits 0 at once", async () => {
    const run = await startAuto("bun");
    await waitForLeaf(run);
    expect(await waitForDaemon(auto)).toBeDefined();
    const r = runCli(auto, "daemon");
    expect(r.code).toBe(0);
    expect(r.err).toContain("another daemon holds the lock");
    run.send("exit");
    await run.proc.exited;
  }, T);

  test("its command line contains neither `bun` nor the package name", async () => {
    const run = await startAuto("bun");
    await waitForLeaf(run);
    const dmn = (await waitForDaemon(auto))!;
    const cmd = Bun.spawnSync(["ps", "-o", "command=", "-p", String(dmn.pid)], { stdout: "pipe" }).stdout.toString().trim();
    expect(cmd).toBe("bsc-daemon -");
    run.send("exit");
    await run.proc.exited;
  }, T);

  test("killed by a descendant, it is restarted by the live owner, which is then reaped on SIGKILL", async () => {
    const run = await startAuto("kill-daemon");
    const killed = Number((await run.waitFor(/^KILLED-DAEMON (\d+)$/))[1]);
    const leaf = await waitForLeaf(run);
    let fresh = liveDaemon(auto);
    for (let i = 0; i < 100 && (!fresh || fresh.pid === killed); i++) {
      await Bun.sleep(100);
      fresh = liveDaemon(auto);
    }
    expect(fresh && fresh.pid !== killed).toBe(true);
    expect(await waitForArmed(auto, run.ownerPid)).toBe(true); // the new daemon armed NOTE_EXIT
    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);

  test(`killed with the owner's timer off (${LINEAGE_MS_ENV}=0), nobody restarts it: SIGKILL leaves the leaf to the sweep`, async () => {
    const run = await startAuto("kill-daemon", { [LINEAGE_MS_ENV]: "0" });
    await run.waitFor(/^KILLED-DAEMON (\d+)$/);
    const leaf = await waitForLeaf(run);
    await Bun.sleep(500);
    expect(liveDaemon(auto)).toBeUndefined();
    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(true);
    runCli(auto, "sweep");
    expect(await aliveAfter(leaf.pid, 3_000)).toBe(false);
  }, T);

  // A daemon that cannot start must not be relaunched every 2 s forever, and the status must
  // not claim SIGKILL coverage. Backoff after the first failure: 2 s, 4 s, 8 s, 16 s, then
  // give up at 5 failures (launches near 0, 2, 6, 14, 30 s).
  test("a daemon that fails at startup is retried with backoff, then given up on", async () => {
    const failDir = scratchLedgerDir();
    const launches = join(failDir, "launches.txt");
    const count = () => {
      try {
        return readFileSync(launches, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    };
    try {
      const run = await startOwner({ scenario: "bun", pidfile: darwinPidfile(), env: ownerEnv(failDir, "auto", { [TEST_FAIL_ENV]: launches }) });
      expect(run.status.reason).toMatch(/daemon failed to start \(exited/);
      expect(run.status.reason).not.toMatch(/immediate/);
      await Bun.sleep(10_000);
      expect(count()).toBeGreaterThanOrEqual(2);
      expect(count()).toBeLessThanOrEqual(3);

      let gaveUp = "";
      for (let i = 0; i < 40 && !gaveUp; i++) {
        run.send("status");
        await Bun.sleep(1_000);
        gaveUp = run.lines.find((l) => l.startsWith("STATUS ") && l.includes("failed to start 5 times")) ?? "";
      }
      expect(gaveUp).toContain("next use or `bun-spawn-cleanup sweep`");
      expect(count()).toBe(5);
      await Bun.sleep(3_000);
      expect(count()).toBe(5);
      run.send("exit");
      await run.proc.exited;
    } finally {
      disposeLedgerDir(failDir);
    }
  }, 90_000);

  const IDLE = 1_000;
  const startIdle = (dir: string) =>
    startOwner({ scenario: "bun", pidfile: darwinPidfile(), env: ownerEnv(dir, "auto", { [TEST_IDLE_ENV]: String(IDLE) }) });

  test("an auto-started daemon exits after its idle time once the last owner is gone: lock free, daemon.json gone", async () => {
    const idleDir = scratchLedgerDir();
    try {
      const run = await startIdle(idleDir);
      await waitForLeaf(run);
      const dmn = (await waitForDaemon(idleDir))!;
      expect(await waitForArmed(idleDir, run.ownerPid)).toBe(true);
      run.send("exit");
      await run.proc.exited;
      expect(await aliveAfter(dmn.pid, IDLE + 2_000)).toBe(false);
      expect(probeDaemonLock(idleDir)).toBe("free");
      expect(existsSync(join(idleDir, DAEMON_FILE))).toBe(false);
    } finally {
      disposeLedgerDir(idleDir);
    }
  }, T);

  // The daemon unlocks before its last directory check and owners write their ledger before
  // probing the lock, so an owner arriving at any point of the idle exit is served by the
  // old daemon (if its last check saw the ledger) or by a fresh one it starts: never none.
  test("an owner starting around the idle exit is always armed by some daemon", async () => {
    const idleDir = scratchLedgerDir();
    try {
      for (const offset of [IDLE - 200, IDLE - 50, IDLE, IDLE + 50, IDLE + 150, IDLE + 400]) {
        const first = await startIdle(idleDir);
        await waitForLeaf(first);
        expect(await waitForArmed(idleDir, first.ownerPid)).toBe(true);
        first.send("exit");
        await first.proc.exited;
        await Bun.sleep(offset);
        const next = await startIdle(idleDir);
        expect(next.status.reason).toMatch(/daemon (started|running) \(pid \d+\)/);
        expect(await waitForArmed(idleDir, next.ownerPid)).toBe(true);
        next.send("exit");
        await next.proc.exited;
        await reapAll();
      }
    } finally {
      disposeLedgerDir(idleDir);
    }
  }, 120_000);

  test("a daemon started after the owner died sweeps the stale ledger on start", async () => {
    stopDaemon(auto);
    const run = await startOwner({ scenario: "nohup-bg", pidfile: darwinPidfile(), env: ownerEnv(auto, "off") });
    const leaf = await waitForLeaf(run);
    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 1_000)).toBe(true);
    const dmn = Bun.spawn([process.execPath, `${import.meta.dir}/../bin/cli.ts`, "daemon"], {
      env: { ...(process.env as Record<string, string>), BUN_SPAWN_CLEANUP_DIR: auto },
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
    } finally {
      dmn.kill("SIGKILL");
      await dmn.exited;
    }
  }, T);
});
