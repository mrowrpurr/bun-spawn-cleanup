/**
 * macOS: the `/core` setup semantics of the API proposal (sections 2 and 3).
 *
 *   - Options mirror the env knobs, resolved once at setup, option over env over default.
 *     The pure resolution (resolveDarwinConfig) runs on every platform; the end-to-end
 *     checks (ledger directory, no daemon, timer off, no NO_ORPHANS flag) are macOS only.
 *   - Setup adopts descendants that existed before `configureSpawnCleanup()` (spawned with
 *     plain Bun.spawn): contained, in the first ledger, and reaped on clean exit and on
 *     SIGKILL (daemon path).
 *   - `killTree()` with no argument kills every descendant, leaves the owner alive and the
 *     backend working (ledger kept, later spawns tracked).
 *
 * Fixture: fixtures/darwin-core-probe.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DAEMON_ENV, LINEAGE_MS_ENV, NO_ORPHANS_ENV, BUN_NO_ORPHANS, resolveDarwinConfig } from "../src/platform/darwin/index.ts";
import { DAEMON_FILE, DIR_ENV, liveDaemon, readLedger } from "../src/platform/darwin/ledger.ts";
import { procEnv, uniqueIds } from "../src/platform/darwin/ffi.ts";
import { darwinPidfile, disposeLedgerDir, IS_DARWIN, ledgerFiles, ownerEnv, reapStrays, scratchLedgerDir, waitForArmed } from "./darwin-helpers.ts";
import { aliveAfter, hardKill, ownersStarted, pidAlive, readLines, reapAll, sleep, trackLeaf } from "./helpers.ts";

const T = 60_000;
const d = IS_DARWIN ? describe : describe.skip;
const PROBE = join(import.meta.dir, "fixtures", "darwin-core-probe.ts");

describe("darwin options: resolveDarwinConfig (any platform)", () => {
  const KNOBS = [DAEMON_ENV, DIR_ENV, LINEAGE_MS_ENV, NO_ORPHANS_ENV];
  let saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
    for (const k of KNOBS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KNOBS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("defaults with no env and no options", () => {
    const c = resolveDarwinConfig();
    expect(c).toMatchObject({ daemon: "auto", daemonFrom: "default", lineageMs: 250, lineageFrom: "default", noOrphans: false, noOrphansFrom: "default", dirFrom: "default", warnings: [] });
    expect(c.dir).toBe(join(process.env.TMPDIR || tmpdir(), "bun-spawn-cleanup"));
  });

  test("env alone is honoured", () => {
    Object.assign(process.env, { [DAEMON_ENV]: "OFF", [DIR_ENV]: "/env/dir", [LINEAGE_MS_ENV]: "0", [NO_ORPHANS_ENV]: "1" });
    expect(resolveDarwinConfig()).toMatchObject({
      daemon: "off",
      daemonFrom: "env",
      dir: "/env/dir",
      dirFrom: "env",
      lineageMs: 0,
      lineageFrom: "env",
      noOrphans: true,
      noOrphansFrom: "env",
    });
  });

  test("every option wins over the opposite env value", () => {
    Object.assign(process.env, { [DAEMON_ENV]: "auto", [DIR_ENV]: "/env/dir", [LINEAGE_MS_ENV]: "250", [NO_ORPHANS_ENV]: "1" });
    expect(resolveDarwinConfig({ darwin: { daemon: "off", ledgerDir: "/opt/dir", lineageMs: 0, noOrphans: false } })).toMatchObject({
      daemon: "off",
      daemonFrom: "option",
      dir: "/opt/dir",
      dirFrom: "option",
      lineageMs: 0,
      lineageFrom: "option",
      noOrphans: false,
      noOrphansFrom: "option",
    });
    Object.assign(process.env, { [DAEMON_ENV]: "off", [LINEAGE_MS_ENV]: "0", [NO_ORPHANS_ENV]: "0" });
    expect(resolveDarwinConfig({ darwin: { daemon: "auto", lineageMs: 500, noOrphans: true } })).toMatchObject({
      daemon: "auto",
      lineageMs: 500,
      noOrphans: true,
    });
  });

  test("an empty option or env value counts as unset", () => {
    Object.assign(process.env, { [DIR_ENV]: "", [LINEAGE_MS_ENV]: "", [DAEMON_ENV]: "" });
    expect(resolveDarwinConfig({ darwin: { ledgerDir: "" } })).toMatchObject({ dirFrom: "default", lineageMs: 250, daemon: "auto", daemonFrom: "default" });
  });

  test("an invalid lineageMs falls back to 250 with a warning naming its source", () => {
    expect(resolveDarwinConfig({ darwin: { lineageMs: -1 } }).warnings.join()).toMatch(/darwin\.lineageMs option/);
    process.env[LINEAGE_MS_ENV] = "soon";
    const c = resolveDarwinConfig();
    expect(c.lineageMs).toBe(250);
    expect(c.warnings.join()).toContain(LINEAGE_MS_ENV);
  });
});

function cleanEnv(): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.BUN_SPAWN_CLEANUP_DISABLE;
  return env;
}

/** Start the probe owner; `next` resolves the next stdout line matching `re`. */

function startProbe(scenario: string, pidfile: string, env: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, PROBE, scenario, pidfile, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: { ...cleanEnv(), ...env },
  });
  ownersStarted.add(proc.pid);
  const lines = readLines(proc.stdout);
  const seen: string[] = [];
  const next = async (re: RegExp): Promise<RegExpExecArray> => {
    for (;;) {
      const r = await lines.next();
      if (r.done) throw new Error(`probe ended before ${re}; output:\n${seen.join("\n")}`);
      seen.push(r.value);
      const m = re.exec(r.value);
      if (m) return m;
    }
  };
  const send = (cmd: string) => {
    proc.stdin.write(cmd + "\n");
    proc.stdin.flush();
  };
  return { proc, next, send };
}

const json = (m: RegExpExecArray) => JSON.parse(m[1]!);

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

d("darwin: setup adopts descendants spawned before configureSpawnCleanup()", () => {
  const adopt = async (mode: "auto" | "off") => {
    const p = startProbe("adopt", darwinPidfile(), ownerEnv(dir, mode));
    const probe = json(await p.next(/^PROBE (.*)$/));
    trackLeaf(probe.childPid);
    trackLeaf(probe.leafPid);
    return { ...p, probe };
  };

  const expectAdopted = (probe: { childContained: unknown; leafContained: unknown; childUid: string; leafUid: string; ledgerLineage: string[] | null; status: { active: boolean; reason?: string } }) => {
    expect(probe.status.active).toBe(true);
    expect(probe.status.reason).toMatch(/adopted 2 pre-existing descendant\(s\)/);
    expect(probe.childContained).toBe(true);
    expect(probe.leafContained).toBe(true);
    // In the FIRST ledger, written inside setup: before adoption it named only the owner.
    expect(probe.ledgerLineage).toEqual(expect.arrayContaining([probe.childUid, probe.leafUid]));
  };

  test("both are contained and in the first ledger; a clean exit reaps both", async () => {
    const r = await adopt("off");
    expectAdopted(r.probe);
    r.send("exit");
    expect(await r.proc.exited).toBe(0);
    expect(await aliveAfter(r.probe.childPid, 2_000)).toBe(false);
    expect(await aliveAfter(r.probe.leafPid, 2_000)).toBe(false);
  }, T);

  test("SIGKILL of the owner: the daemon reaps both", async () => {
    const r = await adopt("auto");
    expectAdopted(r.probe);
    expect(r.probe.status.reason).toMatch(/daemon (started|running)/);
    expect(await waitForArmed(dir, r.probe.ownerPid)).toBe(true);
    await hardKill(r.probe.ownerPid);
    expect(await aliveAfter(r.probe.childPid, 5_000)).toBe(false);
    expect(await aliveAfter(r.probe.leafPid, 5_000)).toBe(false);
  }, T);
});

d("darwin: killTree() with no argument", () => {
  test("kills both library children and their grandchildren; owner and backend keep working", async () => {
    const p = startProbe("killall", darwinPidfile(), ownerEnv(dir, "off"));
    const pids = json(await p.next(/^PIDS (.*)$/)) as { ownerPid: number; children: number[]; leaves: number[] };
    for (const pid of [...pids.children, ...pids.leaves]) trackLeaf(pid);
    for (const pid of [...pids.children, ...pids.leaves]) expect(pidAlive(pid)).toBe(true);

    p.send("killall");
    const res = json(await p.next(/^KILLALL (.*)$/));
    expect(res.tracked).toBe(true);
    expect(res.detail).toMatch(/^killed \d+$/);
    expect(Number(/\d+/.exec(res.detail)![0])).toBeGreaterThanOrEqual(4);
    for (const pid of [...pids.children, ...pids.leaves]) expect(await aliveAfter(pid, 2_000)).toBe(false);

    // Unlike the exit hook: owner alive, ledger kept, still active, later spawns tracked.
    expect(pidAlive(pids.ownerPid)).toBe(true);
    expect(ledgerFiles(dir).some((f) => f.startsWith(`${pids.ownerPid}-`))).toBe(true);
    p.send("status");
    expect(json(await p.next(/^STATUS (.*)$/)).active).toBe(true);
    p.send("spawn");
    const s = await p.next(/^SPAWNED (\d+) contained=(\w+)$/);
    const later = Number(s[1]);
    trackLeaf(later);
    expect(s[2]).toBe("true");
    p.send(`killtree ${later}`);
    expect(json(await p.next(/^KILLTREE (.*)$/))).toMatchObject({ tracked: true });
    expect(await aliveAfter(later, 2_000)).toBe(false);

    p.send("exit");
    expect(await p.proc.exited).toBe(0);
  }, T);
});

d("darwin: options win over env, end to end", () => {
  let envDir = "";
  let optDir = "";
  beforeAll(() => {
    envDir = scratchLedgerDir();
    optDir = scratchLedgerDir();
  });
  afterAll(() => {
    disposeLedgerDir(envDir);
    disposeLedgerDir(optDir);
  });

  // The opposite of every option below.
  const oppositeEnv = () => ({ [DIR_ENV]: envDir, [DAEMON_ENV]: "auto", [LINEAGE_MS_ENV]: "250", [NO_ORPHANS_ENV]: "1" });

  const run = async (env: Record<string, string>, options: object) => {
    const p = startProbe("options", darwinPidfile(), env, JSON.stringify(options));
    const status = json(await p.next(/^STATUS (.*)$/));
    const ownerPid = Number((await p.next(/^OWNER (\d+)$/))[1]);
    const childPid = Number((await p.next(/^CHILD (\d+)$/))[1]);
    trackLeaf(childPid);
    const leafPid = Number((await p.next(/^LEAF (\d+)$/))[1]);
    trackLeaf(leafPid);
    // Longer than the adaptive timer's slowest tick (2 s): a running timer has seen the leaf.
    await sleep(3_000);
    const ledgerIn = (dir: string) => {
      const f = ledgerFiles(dir).find((n) => n.startsWith(`${ownerPid}-`));
      return f ? readLedger(join(dir, f)) : undefined;
    };
    return { ...p, status, ownerPid, childPid, leafPid, leafUid: String(uniqueIds(leafPid)?.uid), ledgerIn };
  };

  test("daemon off, ledger in the option dir, timer off, no NO_ORPHANS flag, despite the env", async () => {
    const r = await run(oppositeEnv(), { darwin: { daemon: "off", ledgerDir: optDir, lineageMs: 0, noOrphans: false } });
    expect(r.status.active).toBe(true);
    expect(r.status.reason).toMatch(/no daemon \(option darwin\.daemon: off/);
    expect(r.status.reason).toMatch(/owner lineage timer off \(option darwin\.lineageMs/);
    expect(r.status.reason).not.toMatch(new RegExp(BUN_NO_ORPHANS));

    // Ledger: in the option dir only.
    const ledger = r.ledgerIn(optDir);
    expect(ledger).toBeDefined();
    expect(r.ledgerIn(envDir)).toBeUndefined();
    // Timer off: nothing but track() scanned, and the leaf was forked after it.
    expect(ledger!.lineage).not.toContain(r.leafUid);
    // No daemon anywhere.
    expect(liveDaemon(optDir)).toBeUndefined();
    expect(liveDaemon(envDir)).toBeUndefined();
    expect(existsSync(join(optDir, DAEMON_FILE))).toBe(false);
    expect(existsSync(join(envDir, DAEMON_FILE))).toBe(false);
    // noOrphans false beats the env's 1 in the child's env.
    const childEnv = procEnv(r.childPid) ?? [];
    expect(childEnv.some((e) => e.startsWith("BUN_SPAWN_CLEANUP_ID="))).toBe(true);
    expect(childEnv.some((e) => e.startsWith(`${BUN_NO_ORPHANS}=`))).toBe(false);

    // Still contained: the exit hook walks the lineage at kill time.
    r.send("exit");
    expect(await r.proc.exited).toBe(0);
    expect(await aliveAfter(r.leafPid, 2_000)).toBe(false);
    expect(r.ledgerIn(optDir)).toBeUndefined();
  }, T);

  test("CONTROL: with no options the same env applies (env dir, timer on, NO_ORPHANS set)", async () => {
    // Daemon off here too, so this control starts no daemon; the knobs under test are the
    // directory, the timer and NO_ORPHANS.
    const r = await run({ ...oppositeEnv(), [DAEMON_ENV]: "off" }, {});
    expect(r.status.active).toBe(true);
    expect(r.status.reason).toMatch(new RegExp(`no daemon \\(${DAEMON_ENV}=off`));
    expect(r.status.reason).toMatch(new RegExp(`${BUN_NO_ORPHANS}=1 set on every spawn \\(${NO_ORPHANS_ENV}=1`));
    const ledger = r.ledgerIn(envDir);
    expect(ledger).toBeDefined();
    expect(r.ledgerIn(optDir)).toBeUndefined();
    expect(ledger!.lineage).toContain(r.leafUid);
    expect((procEnv(r.childPid) ?? []).includes(`${BUN_NO_ORPHANS}=1`)).toBe(true);
    r.send("exit");
    expect(await r.proc.exited).toBe(0);
    expect(await aliveAfter(r.leafPid, 2_000)).toBe(false);
  }, T);
});
