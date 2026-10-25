/**
 * Linux best-effort backend (child subreaper + supervisor /proc snapshots, env marker as the
 * second net), forced with BUN_SPAWN_CLEANUP_LINUX_MECHANISM=best-effort so it runs on every
 * Linux host, including ones where auto-detection would pick cgroups.
 *
 * The mechanism: the owner is a child subreaper, so every orphan in its tree reparents to it
 * and stays reachable by parent links whatever API created it. The owner registers each new
 * direct child with the supervisor within ~50 ms and the supervisor snapshots the whole tree
 * once a second; when the owner dies the supervisor freezes and kills the recorded set plus
 * everything whose parent chain reaches it. `spawn()` is byte-for-byte `Bun.spawn` (no env
 * injection). Escapes, by design: a deliberate setsid + supervisor kill, brokers, and a
 * non-library orphan created in the last few tens of milliseconds before the owner died,
 * which is why the reaping tests let the tree settle briefly before the SIGKILL.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { BACKEND_MARKER, MECHANISM_ENV } from "../src/platform/linux/index.ts";
import {
  aliveAfter,
  hardKill,
  pidAlive,
  reapAll,
  sleep,
  startOwner,
  tempPidfile,
  trackLeaf,
  waitForLeaf,
  type OwnerOptions,
} from "./helpers.ts";
import { findSupervisorPidByOwner, IS_LINUX, startLinuxOwner, type LinuxOwnerRun } from "./linux-helpers.ts";

const T = 60_000;
const d = IS_LINUX ? describe : describe.skip;
const BEST_EFFORT = { [MECHANISM_ENV]: "best-effort" };
/** Long enough for the owner's direct-child registration (50 ms tick) to reach the supervisor. */
const SETTLE_MS = 300;

const start = (opts: Omit<OwnerOptions, "env">) => startOwner({ ...opts, env: BEST_EFFORT });

afterEach(async () => {
  await reapAll();
});

async function tree(run: LinuxOwnerRun, how: "lib" | "plain"): Promise<[number, number]> {
  run.send(`tree ${how}`);
  const m = await run.waitFor(/^TREE (\d+) (\d+)$/);
  const pair: [number, number] = [Number(m[1]), Number(m[2])];
  pair.forEach(trackLeaf);
  return pair;
}

function ppidOf(pid: number): number | undefined {
  try {
    const stat = require("node:fs").readFileSync(`/proc/${pid}/stat`, "latin1") as string;
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return undefined;
  }
}

d("linux best-effort: status", () => {
  test("owner reports an active best-effort guarantee from the subreaper backend", async () => {
    const run = await start({ scenario: "bun", pidfile: tempPidfile() });
    expect(run.status).toMatchObject({ active: true, guarantee: "best-effort", backend: BACKEND_MARKER });
    // A failed prctl would be named here (and would bring back env injection).
    expect(run.status.reason ?? "").not.toContain("PR_SET_CHILD_SUBREAPER");
    expect(run.childContained).toBe(true);
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true);
  }, T);

  test("spawn() passes env through byte for byte: no marker injection", async () => {
    const run = await startLinuxOwner(BEST_EFFORT);
    expect(run.status.backend).toBe(BACKEND_MARKER);
    run.send("env");
    const out = JSON.parse((await run.waitFor(/^ENV (.*)$/))[1]!);
    expect(out).toBe("BSC_ONLY=1\n");
    await hardKill(run.ownerPid);
  }, T);
});

d("linux best-effort: descendants are reaped on SIGKILL of the owner", () => {
  const scenarios: Array<[string, string]> = [
    ["bun", "grandchild via Bun.spawn"],
    ["detached", "grandchild via Bun.spawn({ detached: true })"],
    ["setsid", "grandchild via util-linux setsid (new session)"],
    ["nohup-bg", "great-grandchild via `sh -c 'nohup ... &'` (sh exits immediately)"],
    ["double-fork", "great-great-grandchild via double fork (classic daemonize)"],
    ["disown", "great-grandchild via bash `& disown`"],
    ["env-strip", "grandchild via `env -i` (marker scrubbed; parent links are not env)"],
  ];

  for (const [scenario, label] of scenarios) {
    test(`${label}: reachable under the owner, dies when owner is SIGKILLed`, async () => {
      const run = await start({ scenario, pidfile: tempPidfile() });
      const leaf = await waitForLeaf(run);
      expect(leaf.contained).toBe(true);
      expect(pidAlive(leaf.pid)).toBe(true);
      await sleep(SETTLE_MS);

      await hardKill(run.ownerPid);
      expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
      expect(await aliveAfter(run.childPid, 1_000)).toBe(false);
    }, T);
  }

  test("grandchild whose parent already exited (reparented to the owner by the subreaper) still dies with the owner", async () => {
    const run = await start({ scenario: "nohup-bg", pidfile: tempPidfile(), childMode: "exit" });
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true);
    expect(await aliveAfter(run.childPid, 5_000)).toBe(false);
    expect(pidAlive(leaf.pid)).toBe(true);
    expect(ppidOf(leaf.pid)).toBe(run.ownerPid);

    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);
});

d("linux best-effort: process-wide via PR_SET_CHILD_SUBREAPER (proposal section 5)", () => {
  test("a plain Bun.spawn double-forked descendant reparents to the owner and is reaped on owner SIGKILL", async () => {
    const run = await startLinuxOwner(BEST_EFFORT);
    run.send("orphan");
    const m = await run.waitFor(/^ORPHAN (\d+) (\d+)$/);
    const leaf = Number(m[1]);
    trackLeaf(leaf);
    expect(Number(m[2])).toBe(run.ownerPid); // the subreaper adopted it, not init
    await sleep(SETTLE_MS);

    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf, 5_000)).toBe(false);
  }, T);

  test("a plain Bun.spawn child and grandchild (never went through the library) die with the owner", async () => {
    const run = await startLinuxOwner(BEST_EFFORT);
    const [c, g] = await tree(run, "plain");
    await sleep(SETTLE_MS);
    await hardKill(run.ownerPid);
    expect(await aliveAfter(c, 5_000)).toBe(false);
    expect(await aliveAfter(g, 5_000)).toBe(false);
  }, T);

  test("existing descendants are adopted: a plain tree spawned before configureSpawnCleanup() dies with the owner", async () => {
    const run = await startLinuxOwner({ ...BEST_EFFORT, LINUX_OWNER_PRE: "1" });
    const pre = await run.waitFor(/^PRE (\d+) (\d+)$/);
    const c = Number(pre[1]);
    const g = Number(pre[2]);
    trackLeaf(c);
    trackLeaf(g);
    const a = await run.waitFor(/^ADOPTED (\d+) (\w+) (\d+) (\w+)$/);
    expect([a[2], a[4]]).toEqual(["true", "true"]);
    await sleep(SETTLE_MS);
    await hardKill(run.ownerPid);
    expect(await aliveAfter(c, 5_000)).toBe(false);
    expect(await aliveAfter(g, 5_000)).toBe(false);
  }, T);
});

d("linux best-effort: other owner termination paths", () => {
  test("clean process.exit(0) reaps the tree", async () => {
    const run = await start({ scenario: "nohup-bg", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    await sleep(SETTLE_MS);
    run.send("exit");
    expect(await run.proc.exited).toBe(0);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);

  test("uncaught exception in the owner reaps the tree", async () => {
    const run = await start({ scenario: "nohup-bg", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    await sleep(SETTLE_MS);
    run.send("throw");
    expect(await run.proc.exited).not.toBe(0);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);
});

d("linux best-effort: killTree", () => {
  test("killTree(child) kills the child and its live descendants, owner stays alive", async () => {
    const run = await start({ scenario: "bun", pidfile: tempPidfile() });
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

  test("killTree(sh) after sh itself exited still kills the grandchild its snapshot saw", async () => {
    const run = await startLinuxOwner(BEST_EFFORT);
    run.send("slowsh");
    const m = await run.waitFor(/^SLOWSH (\d+) (\d+)$/);
    const sh = Number(m[1]);
    const g = Number(m[2]);
    trackLeaf(g);
    expect(await aliveAfter(sh, 5_000)).toBe(false); // sh sleeps 1.5 s, then exits
    expect(pidAlive(g)).toBe(true);
    expect(ppidOf(g)).toBe(run.ownerPid); // orphaned, adopted by the subreaper

    run.send(`killtree ${sh}`);
    const k = JSON.parse((await run.waitFor(/^KILLTREE (.*)$/))[1]!);
    expect(k.tracked).toBe(true);
    expect(await aliveAfter(g, 3_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);
    await hardKill(run.ownerPid);
  }, T);

  // An intermediate that exits within microseconds (nohup-bg's sh) is gone before any
  // snapshot sees its child: that grandchild is not attributed to the child any more (it is
  // now a direct child of the owner), but the owner's death still gets it.
  test("killTree(child) does not refuse after the child exited; owner death still reaps an unattributed orphan", async () => {
    const run = await start({ scenario: "nohup-bg", pidfile: tempPidfile(), childMode: "exit" });
    const leaf = await waitForLeaf(run);
    expect(await aliveAfter(run.childPid, 5_000)).toBe(false);

    run.send("killtree");
    const m = await run.waitFor(/^KILLTREE (.*)$/);
    expect(JSON.parse(m[1]!)).toMatchObject({ tracked: true });

    run.send("exit");
    await run.proc.exited;
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);
});

d("linux best-effort: killTree() with no argument (proposal section 3)", () => {
  test("kills library trees and plain-API orphans, leaves the owner and its supervisor alive", async () => {
    const run = await startLinuxOwner(BEST_EFFORT);
    const pids = [...(await tree(run, "lib")), ...(await tree(run, "lib")), ...(await tree(run, "plain"))];
    run.send("orphan");
    const o = Number((await run.waitFor(/^ORPHAN (\d+) (\d+)$/))[1]);
    trackLeaf(o);
    pids.push(o);
    for (const p of pids) expect(pidAlive(p)).toBe(true);
    const sup = findSupervisorPidByOwner(run.ownerPid);
    expect(sup).toBeDefined();

    run.send("killall");
    const k = JSON.parse((await run.waitFor(/^KILLALL (.*)$/))[1]!);
    expect(k.tracked).toBe(true);
    for (const p of pids) expect(await aliveAfter(p, 3_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);
    expect(pidAlive(sup!)).toBe(true);
    expect((await run.status_()).active).toBe(true);
    await hardKill(run.ownerPid);
  }, T);
});

d("linux best-effort: supervisor restart (proposal section 4.1)", () => {
  test("SIGKILL of the supervisor: restarted, status active again, the tree still dies with the owner", async () => {
    const run = await startLinuxOwner(BEST_EFFORT);
    const sup1 = findSupervisorPidByOwner(run.ownerPid);
    expect(sup1).toBeDefined();
    process.kill(sup1!, "SIGKILL");

    const deadline = Date.now() + 3_000;
    let st = await run.status_();
    let sup2 = findSupervisorPidByOwner(run.ownerPid);
    while (Date.now() < deadline && !(st.active && (st.reason ?? "").includes("supervisor restarted") && sup2 && sup2 !== sup1)) {
      await sleep(100);
      st = await run.status_();
      sup2 = findSupervisorPidByOwner(run.ownerPid);
    }
    expect(st.active).toBe(true);
    expect(st.reason).toContain("supervisor restarted 1 time(s)");
    expect(sup2).toBeDefined();
    expect(sup2).not.toBe(sup1);

    const [c, g] = await tree(run, "lib");
    await sleep(1_500); // let the new supervisor take at least one snapshot
    await hardKill(run.ownerPid);
    expect(await aliveAfter(c, 5_000)).toBe(false);
    expect(await aliveAfter(g, 5_000)).toBe(false);
  }, T);
});

d("linux best-effort: known escapes", () => {
  test("a descendant that leaves with setsid AND whose supervisor is killed escapes (asserted as an escape)", async () => {
    const run = await start({ scenario: "setsid", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true);
    // Kill every supervisor of this owner (main shell and poller share its process group):
    // the original plus each of the 5 restarts the budget allows. Before each kill, poll for
    // the replacement (a slow restart must not end the loop early and then reap the leaf);
    // after the last one, confirm the owner gave up.
    let prev: number | undefined;
    for (let i = 0; i < 6; i++) {
      let sup: number | undefined;
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && ((sup = findSupervisorPidByOwner(run.ownerPid)) === undefined || sup === prev)) await sleep(50);
      expect(sup).toBeDefined();
      expect(sup).not.toBe(prev);
      try {
        process.kill(-sup!, "SIGKILL");
      } catch {
        /* gone */
      }
      prev = sup;
    }
    // The owner notices the 6th exit asynchronously, so a single status request right after the
    // kill can be answered before it: poll. (This run's waitFor does not consume lines, so
    // each reply is read from the lines that arrived after its request.)
    let st: { active: boolean; reason?: string } | undefined;
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      const seen = run.lines.length;
      run.send("status");
      let reply: string | undefined;
      while (Date.now() < until && !(reply = run.lines.slice(seen).find((l) => l.startsWith("STATUS ")))) await sleep(50);
      if (!reply) break;
      st = JSON.parse(reply.slice("STATUS ".length));
      if ((st!.reason ?? "").includes("giving up")) break;
      await sleep(100);
    }
    expect(st?.active).toBe(false);
    expect(st?.reason ?? "").toContain("giving up");
    expect(findSupervisorPidByOwner(run.ownerPid)).toBeUndefined();
    await hardKill(run.ownerPid);
    await sleep(1_500);
    expect(pidAlive(leaf.pid)).toBe(true);
  }, T);
});
