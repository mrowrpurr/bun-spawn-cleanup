/**
 * Linux cgroup v2 backend: containment and reaping.
 *
 * Tree:  bun test -> owner.ts (library) -> child.ts -> [launcher] -> leaf.ts
 *
 * Every "reaped" test SIGKILLs the OWNER, so no cleanup code in the owner ever runs; only
 * the supervisor's `cgroup.kill` can save us. The controls (test/linux-controls.test.ts)
 * run the same trees with BUN_SPAWN_CLEANUP_DISABLE=1 and show the leaves surviving.
 *
 * Skipped when this host gives the library no writable cgroup v2 (the status probe reports
 * which mechanism auto-detection picked); the best-effort suite still runs there.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_CGROUP, BACKEND_CGROUP_LANDLOCK, LANDLOCK_ENV, MECHANISM_ENV, OWN_CGROUP_RE } from "../src/platform/linux/index.ts";
import { landlockAbi } from "../src/platform/linux/landlock.ts";
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
} from "./helpers.ts";
import {
  cgroupDirOf,
  findSupervisorPid,
  findSupervisorPidByOwner,
  hostStatus,
  IS_LINUX,
  procState,
  startLinuxOwner,
  systemdUserAvailable,
  type LinuxOwnerRun,
} from "./linux-helpers.ts";

const T = 60_000;
const host = hostStatus();
const cgroupHost =
  IS_LINUX && host?.active === true && (host.backend === BACKEND_CGROUP || host.backend === BACKEND_CGROUP_LANDLOCK);
const landlockHost = cgroupHost && host.backend === BACKEND_CGROUP_LANDLOCK;
const abi = landlockHost ? landlockAbi() : 0;
const signalScoping = typeof abi === "number" && abi >= 6;
/** Set BSC_TEST_REQUIRE_CGROUP=1 in CI so a host without cgroup access FAILS instead of silently skipping. */
if (IS_LINUX && !cgroupHost) {
  const msg = `linux cgroup suite cannot run here: host picked ${JSON.stringify(host)}`;
  if (process.env.BSC_TEST_REQUIRE_CGROUP === "1") throw new Error(msg);
  console.log(`${msg} (skipping; set BSC_TEST_REQUIRE_CGROUP=1 to fail instead)`);
}
const d = cgroupHost ? describe : describe.skip;
const dLandlock = landlockHost ? describe : describe.skip;
const dNoLandlock = cgroupHost && !landlockHost ? describe : describe.skip;
const dSignals = landlockHost && signalScoping ? describe : describe.skip;
if (cgroupHost) console.log(`linux cgroup suite: backend=${host!.backend} landlock abi=${abi}`);
const systemd = cgroupHost && systemdUserAvailable();
const dSystemd = systemd ? describe : describe.skip;

afterEach(async () => {
  await reapAll();
});

/** The owner's `bsc-*` cgroup directory, derived from any process inside it. */
function ownerCgroupDir(pidInside: number): string | undefined {
  const dir = cgroupDirOf(pidInside);
  if (!dir) return undefined;
  const parts = dir.split("/");
  const i = parts.findIndex((p) => OWN_CGROUP_RE.test(p)); // not the bsc-scope-*.scope segment
  return i < 0 ? undefined : parts.slice(0, i + 1).join("/");
}

/** rmdir an owner cgroup and its c-* children from the runner (used when the supervisor was killed). */
function removeOwnerCgroup(dir: string): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith("c-")) rmdirSync(join(dir, name));
  }
  rmdirSync(dir);
}

async function goneWithin(path: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!existsSync(path)) return true;
    await sleep(100);
  }
  return !existsSync(path);
}

/**
 * The transient-scope route (plain login session whose scope cgroup is root-owned) is not
 * taken on hosts where the cgroup is writable in place, so exercise it directly.
 */
dSystemd("linux cgroup: systemd transient scope migration", () => {
  test("moveSelfToTransientScope lands the caller in a user-writable scope cgroup", async () => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "scope-probe.ts")], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const out = JSON.parse((await p.stdout.text()).trim());
    expect(await p.exited).toBe(0);
    expect(out.moved).toHaveProperty("path");
    expect(out.after).toBe(out.moved.path);
    expect(out.after).not.toBe(out.before);
    expect(out.after.endsWith(`/${out.unit}`)).toBe(true);
    expect(out.writable).toBe(true);
    // systemd garbage-collects the scope once its last process (the probe) has exited.
    expect(await goneWithin(`/sys/fs/cgroup${out.after}`, 5_000)).toBe(true);
  }, T);
});

d("linux cgroup: status", () => {
  test("owner reports the same active status the host probe saw", async () => {
    const run = await startOwner({ scenario: "bun", pidfile: tempPidfile() });
    expect(run.status).toMatchObject({ active: true, guarantee: host!.guarantee, backend: host!.backend });
    expect(["kernel", "best-effort"]).toContain(run.status.guarantee);
    if (run.status.guarantee !== "kernel") expect(run.status.reason).toBeDefined();
    expect(run.childContained).toBe(true);
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true);
    expect(ownerCgroupDir(leaf.pid)).toBeDefined();
  }, T);

  test(`${MECHANISM_ENV}=cgroup pins the cgroup backend`, async () => {
    const run = await startOwner({ scenario: "bun", pidfile: tempPidfile(), env: { [MECHANISM_ENV]: "cgroup" } });
    expect(run.status).toMatchObject({ active: true, guarantee: host!.guarantee, backend: host!.backend });
    await waitForLeaf(run);
  }, T);

  test(`${LANDLOCK_ENV}=0 keeps the cgroup but downgrades to best-effort and says why`, async () => {
    const run = await startOwner({ scenario: "bun", pidfile: tempPidfile(), env: { [LANDLOCK_ENV]: "0" } });
    expect(run.status).toMatchObject({ active: true, guarantee: "best-effort", backend: BACKEND_CGROUP });
    expect(run.status.reason).toContain("can leave the cgroup");
    await waitForLeaf(run);
  }, T);

  test("BUN_SPAWN_CLEANUP_DISABLE=1 turns the backend off and says why", async () => {
    const run = await startOwner({ scenario: "bun", pidfile: tempPidfile(), disable: true });
    expect(run.status.active).toBe(false);
    expect(run.status.reason).toContain("BUN_SPAWN_CLEANUP_DISABLE");
    expect(run.childContained).toBeUndefined();
    await waitForLeaf(run);
  }, T);
});

d("linux cgroup: descendants are contained and reaped on SIGKILL of the owner", () => {
  const scenarios: Array<[string, string]> = [
    ["bun", "grandchild via Bun.spawn"],
    ["detached", "grandchild via Bun.spawn({ detached: true })"],
    ["setsid", "grandchild via util-linux setsid (new session)"],
    ["nohup-bg", "great-grandchild via `sh -c 'nohup ... &'` (sh exits immediately)"],
    ["double-fork", "great-great-grandchild via double fork (classic daemonize)"],
    ["disown", "great-grandchild via bash `& disown`"],
    ["env-strip", "grandchild via `env -i` (environment scrubbed)"],
  ];

  for (const [scenario, label] of scenarios) {
    test(`${label}: in cgroup, dies when owner is SIGKILLed`, async () => {
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
    const run = await startOwner({ scenario: "nohup-bg", pidfile: tempPidfile(), childMode: "exit" });
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true);
    expect(await aliveAfter(run.childPid, 5_000)).toBe(false);
    expect(pidAlive(leaf.pid)).toBe(true);

    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);

  test("the owner's cgroup directory is removed after the owner dies (no leak in cgroupfs)", async () => {
    const run = await startOwner({ scenario: "double-fork", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    const dir = ownerCgroupDir(leaf.pid)!;
    expect(existsSync(dir)).toBe(true);

    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
    expect(await goneWithin(dir, 5_000)).toBe(true);
  }, T);
});

d("linux cgroup: the supervisor's death detection", () => {
  test("an owner whose parent never reaps it (zombie) is still cleaned up", async () => {
    const run = await startOwner({ scenario: "nohup-bg", pidfile: tempPidfile(), zombieParent: true });
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true);

    await hardKill(run.ownerPid);
    await sleep(300);
    // The owner is now a zombie: present in /proc, state Z, same start time.
    expect(readFileSync(`/proc/${run.ownerPid}/stat`, "latin1").slice(readFileSync(`/proc/${run.ownerPid}/stat`, "latin1").lastIndexOf(")") + 2)[0]).toBe("Z");
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
    run.proc.kill(); // the sleep standing in as the parent
  }, T);

  test("a descendant cannot obtain a write end of the trigger pipe via /proc/<owner>/fd", async () => {
    const run = await startOwner({ scenario: "reopen-pipe", pidfile: tempPidfile() });
    const r = await run.waitFor(/^REOPEN (\d+) attempts: ?(.*)$/);
    expect(Number(r[1])).toBeGreaterThan(0);
    expect(r[2]).not.toContain("OPENED");
    const leaf = await waitForLeaf(run);

    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);
});

d("linux cgroup: the supervisor itself", () => {
  /** The supervisor shell pid for a run, via the bsc-<pid>-<hex> token in the leaf's cgroup path. */
  function supervisorOf(leafPid: number): number {
    const dir = ownerCgroupDir(leafPid)!;
    const token = dir.slice(dir.lastIndexOf("/") + 1);
    const pid = findSupervisorPid(token);
    expect(pid).toBeDefined();
    return pid!;
  }

  test("its command line contains neither 'bun' nor the package name nor the cgroup path", async () => {
    const run = await startOwner({ scenario: "bun", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    const sup = supervisorOf(leaf.pid);
    const cmdline = readFileSync(`/proc/${sup}/cmdline`, "latin1").split("\0").join(" ");
    expect(cmdline).not.toMatch(/bun/i);
    expect(cmdline).not.toContain("/sys/fs/cgroup");
    expect(cmdline).toContain("bsc-supervisor");
  }, T);

  test("the liveness poller alone reaps the tree when the main supervisor shell is stopped", async () => {
    const run = await startOwner({ scenario: "nohup-bg", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    const sup = supervisorOf(leaf.pid);
    try {
      process.kill(sup, "SIGSTOP");
      await sleep(100);
      expect(procState(sup)).toBe("T"); // EOF can no longer be acted on by the main shell

      await hardKill(run.ownerPid);
      expect(await aliveAfter(leaf.pid, 6_000)).toBe(false); // poller period is 1 s
    } finally {
      try {
        process.kill(sup, "SIGCONT");
      } catch {
        /* already gone */
      }
    }
  }, T);

  // Landlock only: the window exists because the landlocked owner routes cgroupfs writes
  // through the supervisor. Without Landlock the owner does the per-spawn move itself,
  // synchronously, so a stopped supervisor changes nothing and `c-<pid>` already exists.
  (landlockHost ? test : test.skip)("killTree reports tracked: false when the per-spawn move cannot land, and succeeds once it does", async () => {
    const run = await startOwner({ scenario: "bun", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    const sup = supervisorOf(leaf.pid);
    let sleeper = 0;
    try {
      process.kill(sup, "SIGSTOP"); // the supervisor can no longer process `track`
      await sleep(100);
      run.send("spawn");
      sleeper = Number((await run.waitFor(/^SPAWNED (\d+)$/))[1]);
      trackLeaf(sleeper);
      // Reproduce the exact window between the supervisor's mkdir and its cgroup.procs
      // write: the per-spawn directory exists, the child is not in it.
      mkdirSync(`${ownerCgroupDir(leaf.pid)}/c-${sleeper}`);

      run.send(`killtree ${sleeper}`);
      const first = JSON.parse((await run.waitFor(/^KILLTREE (.*)$/))[1]!);
      expect(first.tracked).toBe(false);
      expect(first.detail).toContain("never received");
      // Accurate reporting pays: `tracked: false` makes the public killTree() fall back to proc.kill().
      expect(await aliveAfter(sleeper, 2_000)).toBe(false);

      process.kill(sup, "SIGCONT"); // the supervisor catches up on its queue
      await sleep(300);
      run.lines.length = 0; // forget earlier SPAWNED/KILLTREE lines so waitFor sees the next ones
      run.send("spawn");
      const sleeper2 = Number((await run.waitFor(/^SPAWNED (\d+)$/))[1]);
      trackLeaf(sleeper2);
      await sleep(100); // let `track` land
      run.send(`killtree ${sleeper2}`);
      const second = JSON.parse((await run.waitFor(/^KILLTREE (.*)$/))[1]!);
      expect(second).toMatchObject({ tracked: true });
      expect(second.detail).toContain("confirmed empty");
      expect(await aliveAfter(sleeper2, 2_000)).toBe(false);
    } finally {
      try {
        process.kill(sup, "SIGCONT");
      } catch {
        /* already gone */
      }
    }
    run.send("exit");
    await run.proc.exited;
  }, T);
});

d("linux cgroup: nesting", () => {
  test("a nested owner stays inside the outer cgroup and reports best-effort of its own", async () => {
    const run = await startOwner({ scenario: "nested-owner", pidfile: tempPidfile() });
    const n = await run.waitFor(/^NESTED (.*)$/);
    const nested = JSON.parse(n[1]!);
    expect(nested.active).toBe(true);
    expect(nested.backend).toBe("linux-best-effort");
    expect(nested.reason).toContain("nested inside another bun-spawn-cleanup owner");
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true); // contained by the OUTER owner

    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);

  test(`an inherited ${MECHANISM_ENV}=cgroup does not make a nested owner report failure`, async () => {
    const run = await startOwner({ scenario: "nested-owner", pidfile: tempPidfile(), env: { [MECHANISM_ENV]: "cgroup" } });
    const nested = JSON.parse((await run.waitFor(/^NESTED (.*)$/))[1]!);
    expect(nested).toMatchObject({ active: true, backend: "linux-best-effort", guarantee: "best-effort" });
    expect(nested.reason).toContain("nested inside");
    await waitForLeaf(run);
  }, T);
});

d("linux cgroup: other owner termination paths", () => {
  test("clean process.exit(0) reaps the tree", async () => {
    const run = await startOwner({ scenario: "nohup-bg", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    run.send("exit");
    expect(await run.proc.exited).toBe(0);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);

  test("uncaught exception in the owner reaps the tree", async () => {
    const run = await startOwner({ scenario: "nohup-bg", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    run.send("throw");
    expect(await run.proc.exited).not.toBe(0);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);

  test("SIGTERM to the owner reaps the tree", async () => {
    const run = await startOwner({ scenario: "setsid", pidfile: tempPidfile() });
    const leaf = await waitForLeaf(run);
    process.kill(run.ownerPid, "SIGTERM");
    await run.proc.exited;
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
  }, T);
});

d("linux cgroup: killTree", () => {
  test("killTree(child) kills the child's subtree and leaves the owner alive", async () => {
    const run = await startOwner({ scenario: "nohup-bg", pidfile: tempPidfile() });
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
    const run = await startOwner({ scenario: "nohup-bg", pidfile: tempPidfile(), childMode: "exit" });
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

/**
 * Landlock closes the same-UID holes. A descendant may try to write its pid into an
 * ancestor cgroup's cgroup.procs (allowed by cgroup v2 DAC, since the user owns both
 * directories) or to kill the supervisor; with the inherited, irrevocable ruleset the
 * kernel refuses both.
 */
dLandlock("linux cgroup+landlock: escape attempts are refused by the kernel", () => {
  test("a descendant writing its pid into an ancestor cgroup.procs gets EACCES and dies with the owner", async () => {
    const run = await startOwner({ scenario: "cgroup-escape", pidfile: tempPidfile() });
    const esc = await run.waitFor(/^CGROUP-ESCAPE (.*)$/);
    expect(esc[1]).toBe("error EACCES");
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(true);

    await hardKill(run.ownerPid);
    expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
    expect(await aliveAfter(run.childPid, 1_000)).toBe(false);
  }, T);

  test("a Worker created before the first spawn is sandboxed too (TSYNC), or the status says it is not", async () => {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "worker-probe.ts")], {
      stdout: "pipe",
      stderr: "inherit",
    });
    const out = JSON.parse((await p.stdout.text()).trim());
    expect(await p.exited).toBe(0);
    expect(out.status.backend).toBe(BACKEND_CGROUP_LANDLOCK);
    const tsync = !/no TSYNC/.test(out.status.reason ?? "");
    expect(out.workerChild).toBe(tsync ? "denied" : "ok");
  }, T);

  test("CONTROL: with Landlock off the same write succeeds and the leaf escapes", async () => {
    const run = await startOwner({ scenario: "cgroup-escape", pidfile: tempPidfile(), env: { [LANDLOCK_ENV]: "0" } });
    const esc = await run.waitFor(/^CGROUP-ESCAPE (.*)$/);
    expect(esc[1]).toBe("ok");
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(false);

    await hardKill(run.ownerPid);
    await sleep(1_500);
    expect(pidAlive(leaf.pid)).toBe(true);
  }, T);

  dSignals("signal scoping (Landlock ABI 6+)", () => {
    test("a descendant that tries to SIGKILL the supervisor gets EPERM and still dies with the owner", async () => {
      const run = await startOwner({ scenario: "kill-supervisor", pidfile: tempPidfile() });
      const r = await run.waitFor(/^KILL-SUPERVISOR (.*)$/);
      expect(r[1]).toBe("error EPERM");
      const leaf = await waitForLeaf(run);
      expect(leaf.contained).toBe(true);

      await hardKill(run.ownerPid);
      expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
    }, T);

    test("with Landlock off a descendant can kill the supervisor, the owner restarts it, and the tree is still reaped", async () => {
      const run = await startOwner({ scenario: "kill-supervisor", pidfile: tempPidfile(), env: { [LANDLOCK_ENV]: "0" } });
      const r = await run.waitFor(/^KILL-SUPERVISOR (.*)$/);
      expect(r[1]).toBe("ok");
      const leaf = await waitForLeaf(run);
      const dir = ownerCgroupDir(leaf.pid)!;
      try {
        // The owner notices and restarts it with the same startSupervisor call as setup.
        await sleep(500);
        run.send("status");
        const after = JSON.parse((await run.waitFor(/^STATUS (.*supervisor restarted.*)$/))[1]!);
        expect(after.active).toBe(true);
        expect(findSupervisorPidByOwner(run.ownerPid)).toBeDefined();

        await hardKill(run.ownerPid);
        expect(await aliveAfter(leaf.pid, 5_000)).toBe(false);
        expect(await goneWithin(dir, 10_000)).toBe(true);
      } finally {
        await reapAll();
        if (existsSync(dir)) removeOwnerCgroup(dir);
      }
    }, T);
  });
});

/** Without Landlock the same-UID hole is real; assert it so the status reason stays accurate. */
dNoLandlock("linux cgroup WITHOUT landlock: same-UID escape is open (asserted as an escape)", () => {
  test("a descendant that moves itself to an ancestor cgroup escapes", async () => {
    const run = await startOwner({ scenario: "cgroup-escape", pidfile: tempPidfile() });
    expect(run.status.guarantee).toBe("best-effort");
    expect(run.status.reason).toContain("can leave the cgroup");
    const esc = await run.waitFor(/^CGROUP-ESCAPE (.*)$/);
    expect(esc[1]).toBe("ok");
    const leaf = await waitForLeaf(run);
    expect(leaf.contained).toBe(false);

    await hardKill(run.ownerPid);
    await sleep(1_500);
    expect(pidAlive(leaf.pid)).toBe(true);
  }, T);
});

/**
 * Brokers: the user's systemd instance is a daemon outside our cgroup and sandbox, like
 * WMI on Windows. Whatever it starts on a descendant's request is not our descendant. No
 * unprivileged mechanism on any OS closes IPC to a process-spawning daemon.
 */
dSystemd("linux cgroup: broker escapes via systemd-run --user (asserted as escapes)", () => {
  for (const [scenario, label] of [
    ["systemd-run-scope", "transient scope (command run by systemd-run, in a new cgroup)"],
    ["systemd-run-service", "transient service (command forked by the user manager)"],
  ] as Array<[string, string]>) {
    test(`${label} escapes the cgroup`, async () => {
      const run = await startOwner({ scenario, pidfile: tempPidfile() });
      const leaf = await waitForLeaf(run);
      expect(leaf.contained).toBe(false);

      await hardKill(run.ownerPid);
      await sleep(1_500);
      expect(pidAlive(leaf.pid)).toBe(true);
    }, T);
  }
});

// -----------------------------------------------------------------------------------------
// Proposal sections 2-4: adopt, killTree() with no argument, supervisor restart, dead-owner
// sweep, CLI. All via test/fixtures/linux-owner.ts (`/core`, setup where the fixture says).
// -----------------------------------------------------------------------------------------

const CLI = join(import.meta.dir, "..", "bin", "cli.ts");

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "inherit" });
  const out = await p.stdout.text();
  return { code: await p.exited, out };
}

/** Poll `status` until the owner reports a restarted, active supervisor other than `old`. */
/**
 * Poll until the owner reports restart number `n` AND a supervisor other than `old` exists.
 * Both are required: a STATUS reply can predate the restart that the following /proc scan
 * then sees, so "some restart" + "new pid" would accept the previous restart's status.
 */
async function waitForRestart(run: LinuxOwnerRun, old: number, n: number, ms = 3_000) {
  const deadline = Date.now() + ms;
  const want = `supervisor restarted ${n} time(s)`;
  let st = await run.status_();
  let sup = findSupervisorPidByOwner(run.ownerPid);
  while (Date.now() < deadline && !(st.active && (st.reason ?? "").includes(want) && sup !== undefined && sup !== old)) {
    await sleep(100);
    st = await run.status_();
    sup = findSupervisorPidByOwner(run.ownerPid);
  }
  return { st, sup };
}

async function tree(run: LinuxOwnerRun, how: "lib" | "plain"): Promise<[number, number]> {
  run.send(`tree ${how}`);
  const m = await run.waitFor(/^TREE (\d+) (\d+)$/);
  const pair: [number, number] = [Number(m[1]), Number(m[2])];
  pair.forEach(trackLeaf);
  return pair;
}

/**
 * A leaked owner cgroup as a killed supervisor leaves it: `bsc-<dead pid>-abcdef` next to
 * where owners started by this runner create theirs (the runner's own cgroup), with a live
 * sleeper inside. Undefined when this runner's cgroup is not writable in place (owners then
 * take the transient-scope route and their siblings are elsewhere).
 */
async function fakeDeadOwner(): Promise<{ dir: string; name: string; sleeper: number } | undefined> {
  const parent = cgroupDirOf(process.pid);
  if (!parent) return undefined;
  const gone = Bun.spawn(["true"]);
  await gone.exited;
  if (pidAlive(gone.pid)) return undefined;
  const name = `bsc-${gone.pid}-abcdef`;
  const dir = `${parent}/${name}`;
  try {
    mkdirSync(dir);
  } catch {
    console.log(`fakeDeadOwner: cannot mkdir under ${parent}; skipping`);
    return undefined;
  }
  const sleeper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1e9)"], { stdio: ["ignore", "ignore", "ignore"] });
  trackLeaf(sleeper.pid);
  try {
    writeFileSync(`${dir}/cgroup.procs`, String(sleeper.pid));
  } catch (e) {
    sleeper.kill("SIGKILL");
    await sleeper.exited;
    rmdirSync(dir);
    console.log(`fakeDeadOwner: cannot move a sleeper into ${dir} (${(e as NodeJS.ErrnoException).code}); skipping`);
    return undefined;
  }
  return { dir, name, sleeper: sleeper.pid };
}

function removeIfLeft(dir: string): void {
  try {
    if (existsSync(dir)) removeOwnerCgroup(dir);
  } catch {
    /* best effort */
  }
}

d("linux cgroup: adopt existing descendants (proposal section 2)", () => {
  test("a plain Bun.spawn child + grandchild started before configureSpawnCleanup() join the cgroup and die with the owner", async () => {
    const run = await startLinuxOwner({ LINUX_OWNER_PRE: "1" });
    const pre = await run.waitFor(/^PRE (\d+) (\d+)$/);
    const c = Number(pre[1]);
    const g = Number(pre[2]);
    trackLeaf(c);
    trackLeaf(g);
    const a = await run.waitFor(/^ADOPTED (\d+) (\w+) (\d+) (\w+)$/);
    expect(run.status.active).toBe(true);
    expect(run.status.reason ?? "").not.toContain("pre-existing descendant");
    if (landlockHost) {
      // Moved in before the ruleset: outside the sandbox, so not a kernel guarantee any more.
      expect(run.status.guarantee).toBe("best-effort");
      expect(run.status.reason).toContain("2 adopted pre-existing process(es) are outside the Landlock sandbox");
    }
    expect([a[2], a[4]]).toEqual(["true", "true"]);
    expect(cgroupDirOf(c)).toBe(cgroupDirOf(run.ownerPid));
    expect(cgroupDirOf(g)).toBe(cgroupDirOf(run.ownerPid));

    await hardKill(run.ownerPid);
    expect(await aliveAfter(c, 5_000)).toBe(false);
    expect(await aliveAfter(g, 5_000)).toBe(false);
  }, T);

  test("killTree() with no argument reaches adopted processes too (via the supervisor under Landlock)", async () => {
    const run = await startLinuxOwner({ LINUX_OWNER_PRE: "1" });
    const pre = await run.waitFor(/^PRE (\d+) (\d+)$/);
    const adopted = [Number(pre[1]), Number(pre[2])];
    adopted.forEach(trackLeaf);
    const lib = await tree(run, "lib");
    run.send("killall");
    const k = JSON.parse((await run.waitFor(/^KILLALL (.*)$/))[1]!);
    expect(k).toMatchObject({ tracked: true });
    for (const p of [...adopted, ...lib]) expect(await aliveAfter(p, 3_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);
    await hardKill(run.ownerPid);
  }, T);
});

d("linux cgroup: killTree() with no argument (proposal section 3)", () => {
  test("kills every descendant (library and plain spawns, with grandchildren), leaves the owner and its supervisor alive", async () => {
    const run = await startLinuxOwner();
    const pids = [...(await tree(run, "lib")), ...(await tree(run, "lib")), ...(await tree(run, "plain"))];
    for (const p of pids) expect(pidAlive(p)).toBe(true);
    const sup = findSupervisorPidByOwner(run.ownerPid);
    expect(sup).toBeDefined();

    run.send("killall");
    const k = JSON.parse((await run.waitFor(/^KILLALL (.*)$/))[1]!);
    expect(k.tracked).toBe(true);
    for (const p of pids) expect(await aliveAfter(p, 3_000)).toBe(false);
    expect(pidAlive(run.ownerPid)).toBe(true);
    expect((await run.status_()).active).toBe(true);
    expect(pidAlive(sup!)).toBe(true);

    // Repeatable, and the backend still works afterwards.
    const again = await tree(run, "lib");
    await hardKill(run.ownerPid);
    for (const p of again) expect(await aliveAfter(p, 5_000)).toBe(false);
  }, T);
});

d("linux cgroup: supervisor restart (proposal section 4.1)", () => {
  test("SIGKILL of the supervisor from outside: restarted within ~2 s, status active again, the tree still dies with the owner", async () => {
    const run = await startLinuxOwner();
    const [c, g] = await tree(run, "lib");
    const dir = ownerCgroupDir(run.ownerPid)!;
    const sup1 = findSupervisorPidByOwner(run.ownerPid);
    expect(sup1).toBeDefined();

    process.kill(sup1!, "SIGKILL");
    const { st, sup } = await waitForRestart(run, sup1!, 1);
    expect(st.active).toBe(true);
    expect(st.reason).toContain("supervisor restarted 1 time(s)");
    expect(sup).toBeDefined();
    expect(sup).not.toBe(sup1);
    if (landlockHost) {
      // A Landlocked owner can only start it inside its own sandbox: reported downgrade.
      expect(st.guarantee).toBe("best-effort");
      expect(st.reason).toContain("inside the Landlock sandbox");
    } else {
      expect(st.guarantee).toBe(host!.guarantee);
      expect(cgroupDirOf(sup!)).not.toBe(dir); // moved back out of the cgroup it will kill
    }

    // Per-spawn tracking still works after the restart.
    const [c2, g2] = await tree(run, "lib");
    await hardKill(run.ownerPid);
    for (const p of [c, g, c2, g2]) expect(await aliveAfter(p, 5_000)).toBe(false);
    // The old supervisor's poller (this test killed only the main shell) or the new one removes it.
    const gone = await goneWithin(dir, 10_000);
    if (!gone) removeIfLeft(dir);
    expect(gone).toBe(true);
  }, T);

  test("after 5 restarts within 60 s the next supervisor death gives up: active false, 'giving up'", async () => {
    const run = await startLinuxOwner();
    const [c] = await tree(run, "lib");
    const dir = ownerCgroupDir(run.ownerPid)!;
    let sup = findSupervisorPidByOwner(run.ownerPid)!;
    for (let i = 1; i <= 5; i++) {
      process.kill(sup, "SIGKILL");
      const r = await waitForRestart(run, sup, i);
      expect(r.st.reason).toContain(`supervisor restarted ${i} time(s)`);
      sup = r.sup!;
    }
    process.kill(sup, "SIGKILL");
    await sleep(500);
    const st = await run.status_();
    expect(st.active).toBe(false);
    expect(st.reason).toContain("giving up");

    // The killed shells' pollers are still alive and still reap the tree on owner death.
    await hardKill(run.ownerPid);
    expect(await aliveAfter(c, 6_000)).toBe(false);
    if (!(await goneWithin(dir, 10_000))) removeIfLeft(dir);
  }, T);
});

d("linux cgroup: dead-owner sweep (proposal section 4.2)", () => {
  test("an owner's setup kills and removes a sibling bsc-<dead pid>-* cgroup", async () => {
    const f = await fakeDeadOwner();
    if (!f) return;
    try {
      const run = await startOwner({ scenario: "bun", pidfile: tempPidfile() });
      expect(run.status.active).toBe(true);
      expect(await aliveAfter(f.sleeper, 3_000)).toBe(false);
      expect(await goneWithin(f.dir, 3_000)).toBe(true);
      await waitForLeaf(run);
    } finally {
      removeIfLeft(f.dir);
    }
  }, T);

  test("a LIVE owner's cgroup is never swept by another owner's setup", async () => {
    const a = await startLinuxOwner();
    const [c] = await tree(a, "lib");
    const dirA = ownerCgroupDir(a.ownerPid)!;
    const b = await startLinuxOwner();
    expect(b.status.active).toBe(true);
    expect(existsSync(dirA)).toBe(true);
    expect(pidAlive(c)).toBe(true);
    await hardKill(a.ownerPid);
    await hardKill(b.ownerPid);
  }, T);
});

d("linux cgroup: CLI (proposal section 4.3)", () => {
  test("`sweep` kills and removes a dead owner's cgroup and prints it", async () => {
    const f = await fakeDeadOwner();
    if (!f) return;
    try {
      const r = await cli("sweep");
      expect(r.code).toBe(0);
      expect(r.out).toContain(`swept owner ${f.name}`);
      expect(r.out).toContain(`killed 1 process(es) (${f.sleeper})`);
      expect(r.out).toContain(", removed");
      expect(await aliveAfter(f.sleeper, 3_000)).toBe(false);
      expect(existsSync(f.dir)).toBe(false);
      expect((await cli("sweep")).out).not.toContain(f.name);
    } finally {
      removeIfLeft(f.dir);
    }
  }, T);

  test("`status` and `ls` list a live owner, its pid and members", async () => {
    const run = await startLinuxOwner();
    const [c, g] = await tree(run, "lib");
    const name = ownerCgroupDir(run.ownerPid)!.split("/").pop()!;
    const st = await cli("status");
    expect(st.code).toBe(0);
    expect(st.out).toContain("cgroup2 root: ");
    expect(st.out).toMatch(new RegExp(`owner ${name}: pid ${run.ownerPid} alive, \\d+ member\\(s\\)`));
    const members = Number(new RegExp(`owner ${name}: pid \\d+ alive, (\\d+) member`).exec(st.out)?.[1]);
    expect(members).toBeGreaterThanOrEqual(3); // owner, child, grandchild
    const ls = await cli("ls");
    expect(ls.out).toContain(`owner ${name} (pid ${run.ownerPid} alive`);
    for (const p of [run.ownerPid, c, g]) expect(ls.out).toMatch(new RegExp(`^  ${p} `, "m"));
    expect((await cli("daemon")).out).toContain("not needed on this platform");
    await hardKill(run.ownerPid);
  }, T);
});
