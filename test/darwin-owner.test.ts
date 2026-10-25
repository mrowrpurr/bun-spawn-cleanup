/**
 * macOS: deaths the owner can see are handled by the owner itself, immediately, with NO
 * daemon (BUN_SPAWN_CLEANUP_DARWIN_DAEMON=off), so these prove the owner-side hooks alone:
 * `process.on("exit")` for clean exit / process.exit / uncaught throw, and the
 * SIGINT/SIGTERM/SIGHUP/SIGQUIT hooks, which kill the tree and re-raise so the owner's exit
 * status is the signal's. Also `killTree`, which on macOS reaches orphaned grandchildren
 * (lineage + per-spawn marker), even after the direct child exited.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { disposeLedgerDir, IS_DARWIN, ledgerFiles, ownerEnv, darwinPidfile, reapStrays, scratchLedgerDir, waitForArmed } from "./darwin-helpers.ts";
import { aliveAfter, hardKill, pidAlive, readLines, reapAll, sleep, startOwner, waitForLeaf, type OwnerOptions } from "./helpers.ts";

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

const start = (scenario: string, more: Partial<OwnerOptions> = {}) =>
  startOwner({ scenario, pidfile: darwinPidfile(), env: ownerEnv(dir, "off"), ...more });

d("darwin: owner-visible deaths, no daemon", () => {
  test("status says there is no daemon", async () => {
    const run = await start("bun");
    expect(run.status.active).toBe(true);
    expect(run.status.reason).toMatch(/no daemon/);
    await waitForLeaf(run);
  }, T);

  test("clean process.exit(0) reaps an orphaned grandchild at once and deletes the ledger", async () => {
    const run = await start("nohup-bg");
    const leaf = await waitForLeaf(run);
    expect(ledgerFiles(dir).some((f) => f.startsWith(`${run.ownerPid}-`))).toBe(true);
    run.send("exit");
    expect(await run.proc.exited).toBe(0);
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(false);
    expect(ledgerFiles(dir).some((f) => f.startsWith(`${run.ownerPid}-`))).toBe(false);
  }, T);

  test("uncaught exception in the owner reaps the tree", async () => {
    const run = await start("double-fork");
    const leaf = await waitForLeaf(run);
    run.send("throw");
    expect(await run.proc.exited).not.toBe(0);
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(false);
  }, T);

  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const) {
    test(`${sig} to the owner reaps the tree and the owner still dies by ${sig}`, async () => {
      const run = await start("setsid");
      const leaf = await waitForLeaf(run);
      process.kill(run.ownerPid, sig);
      await run.proc.exited;
      expect(run.proc.signalCode).toBe(sig);
      expect(await aliveAfter(leaf.pid, 2_000)).toBe(false);
    }, T);
  }
});

d("darwin: an app's own signal listener", () => {
  // The hook defers to the app: with its own SIGTERM listener the app decides to keep
  // running, so neither it nor its tree may die; its later exit still reaps the tree.
  test("with an app SIGTERM listener, SIGTERM kills neither owner nor leaf; a later clean exit reaps", async () => {
    const run = await start("nohup-bg", { env: { ...ownerEnv(dir, "off"), OWNER_LISTEN: "SIGTERM" } });
    expect(run.status.active).toBe(true);
    await run.waitFor(/^LISTENING SIGTERM$/);
    const leaf = await waitForLeaf(run);
    process.kill(run.ownerPid, "SIGTERM");
    expect(await aliveAfter(run.ownerPid, 1_000)).toBe(true);
    expect(pidAlive(leaf.pid)).toBe(true);
    run.send("exit");
    expect(await run.proc.exited).toBe(0);
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(false);
  }, T);
});

d("darwin: inherited ignored signals are left alone", () => {
  // Under `nohup` SIGHUP is ignored; a background job of a non-interactive shell ignores
  // SIGINT. Installing a listener would make those signals fatal again (it did, before the
  // sigaction check): the owner must survive them, and stay covered for real deaths.
  for (const [sig, trap] of [
    ["SIGHUP", "HUP"],
    ["SIGINT", "INT"],
  ] as const) {
    test(`owner started with ${sig} ignored survives ${sig}; its tree is still reaped on SIGKILL`, async () => {
      const run = await start("nohup-bg", { wrap: ["sh", "-c", `trap "" ${trap}; exec "$@"`, "sh"], env: ownerEnv(dir, "auto") });
      expect(run.status.active).toBe(true);
      const leaf = await waitForLeaf(run);
      process.kill(run.ownerPid, sig);
      expect(await aliveAfter(run.ownerPid, 1_000)).toBe(true);
      expect(pidAlive(leaf.pid)).toBe(true);
      expect(await waitForArmed(dir, run.ownerPid)).toBe(true);
      await hardKill(run.ownerPid);
      expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
    }, T);
  }
});

d("darwin: Worker-thread owners", () => {
  // `worker.terminate()` runs no exit hook in the Worker. Decision: what a terminated Worker
  // spawned dies with the PROCESS: the main thread's exit hook (process-wide lineage) and,
  // for SIGKILL, the daemon's NOTE_EXIT on the process pid, which covers its t* ledgers.
  const startWorkerOwner = (mode: "auto" | "off") => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "darwin-worker-owner.ts"), darwinPidfile()], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...(process.env as Record<string, string>), ...ownerEnv(dir, mode) },
    });
    const lines = readLines(proc.stdout);
    const next = async (re: RegExp) => {
      for (;;) {
        const r = await lines.next();
        if (r.done) throw new Error(`fixture ended before ${re}`);
        const m = re.exec(r.value);
        if (m) return m;
      }
    };
    return { proc, next };
  };

  test("a terminated Worker's child lives on, then dies with the process's clean exit; no ledger is left", async () => {
    const w = startWorkerOwner("off");
    const leaf = Number((await w.next(/^LEAF (\d+)$/))[1]);
    await w.next(/^TERMINATED$/);
    expect(await aliveAfter(leaf, 500)).toBe(true);
    expect(ledgerFiles(dir).some((f) => new RegExp(`^${w.proc.pid}-\\d+t\\d+\\.json$`).test(f))).toBe(true);
    w.proc.stdin.write("exit\n");
    w.proc.stdin.flush();
    expect(await w.proc.exited).toBe(0);
    expect(await aliveAfter(leaf, 2_000)).toBe(false);
    expect(ledgerFiles(dir).some((f) => f.startsWith(`${w.proc.pid}-`))).toBe(false);
  }, T);

  test("SIGKILL of that process: the daemon reaps the terminated Worker's child from its t* ledger", async () => {
    const w = startWorkerOwner("auto");
    const leaf = Number((await w.next(/^LEAF (\d+)$/))[1]);
    await w.next(/^TERMINATED$/);
    expect(await waitForArmed(dir, w.proc.pid)).toBe(true);
    await hardKill(w.proc.pid);
    expect(await aliveAfter(leaf, 5_000)).toBe(false);
  }, T);
});

d("darwin: killTree", () => {
  test("killTree(child) kills the child and an orphaned grandchild; owner stays alive", async () => {
    const run = await start("nohup-bg");
    const leaf = await waitForLeaf(run);
    await run.waitFor(/^READY$/);
    run.send("killtree");
    const m = await run.waitFor(/^KILLTREE (.*)$/);
    expect(JSON.parse(m[1]!)).toMatchObject({ tracked: true });
    expect(await aliveAfter(run.childPid, 2_000)).toBe(false);
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);
    run.send("exit");
    await run.proc.exited;
  }, T);

  test("killTree(child) reaches an env-stripped setsid grandchild through lineage", async () => {
    const run = await start("env-strip");
    const leaf = await waitForLeaf(run);
    await run.waitFor(/^READY$/);
    run.send("killtree");
    expect(JSON.parse((await run.waitFor(/^KILLTREE (.*)$/))[1]!)).toMatchObject({ tracked: true });
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);
    run.send("exit");
    await run.proc.exited;
  }, T);

  test("killTree(child) after the child exited still kills its orphan (unlike Linux best-effort)", async () => {
    const run = await start("nohup-bg", { childMode: "exit" });
    const leaf = await waitForLeaf(run);
    expect(await aliveAfter(run.childPid, 5_000)).toBe(false);
    await sleep(1_000); // several lineage ticks after the exit: the record must survive them
    run.send("killtree");
    expect(JSON.parse((await run.waitFor(/^KILLTREE (.*)$/))[1]!)).toMatchObject({ tracked: true });
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);
    run.send("exit");
    await run.proc.exited;
  }, T);

  test("killTree of one spawn leaves the other spawns' trees alone", async () => {
    const run = await start("nohup-bg");
    const leaf = await waitForLeaf(run);
    run.send("spawn");
    const extra = Number((await run.waitFor(/^SPAWNED (\d+)$/))[1]);
    run.send(`killtree ${extra}`);
    expect(JSON.parse((await run.waitFor(/^KILLTREE (.*)$/))[1]!)).toMatchObject({ tracked: true });
    expect(await aliveAfter(extra, 2_000)).toBe(false);
    expect(pidAlive(leaf.pid)).toBe(true);
    expect(pidAlive(run.childPid)).toBe(true);
    run.send("exit");
    await run.proc.exited;
    expect(await aliveAfter(leaf.pid, 2_000)).toBe(false);
  }, T);
});
