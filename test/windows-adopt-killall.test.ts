/**
 * Windows backend: adopting descendants that existed before setup, and killTree() with no
 * argument (killAll).
 *
 * Fixture: test/fixtures/windows-adopt-probe.ts, which uses `/core` so setup runs exactly
 * after the pre-existing tree is up. Every pid the probe reports is tracked for reapAll, so a
 * failing test never leaks a bun process.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISABLE_ENV } from "../src/backend.ts";
import { aliveAfter, hardKill, IS_WINDOWS, ownersStarted, pidAlive, readLines, reapAll, sleep, trackLeaf } from "./helpers.ts";

const T = 60_000;
const PROBE = join(import.meta.dir, "fixtures", "windows-adopt-probe.ts");

afterEach(async () => {
  await reapAll();
});

interface Probe {
  pid: number;
  waitFor(re: RegExp, timeoutMs?: number): Promise<RegExpExecArray>;
}

function startProbe(args: string[], disable = false): Probe {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (disable) env[DISABLE_ENV] = "1";
  else delete env[DISABLE_ENV];
  const dir = mkdtempSync(join(tmpdir(), "bsc-adopt-"));
  const proc = Bun.spawn([process.execPath, PROBE, args[0]!, dir, ...args.slice(1)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
    env,
  });
  ownersStarted.add(proc.pid);

  const lines: string[] = [];
  const waiters: Array<{ re: RegExp; resolve: (m: RegExpExecArray) => void }> = [];
  (async () => {
    for await (const line of readLines(proc.stdout)) {
      lines.push(line);
      // Track every pid as soon as it is announced, before any assertion can fail.
      const pid = /^(?:CHILD|LEAF) (\d+)$/.exec(line);
      if (pid) trackLeaf(Number(pid[1]));
      for (let i = waiters.length - 1; i >= 0; i--) {
        const m = waiters[i]!.re.exec(line);
        if (m) {
          waiters[i]!.resolve(m);
          waiters.splice(i, 1);
        }
      }
    }
  })();

  return {
    pid: proc.pid,
    waitFor(re, timeoutMs = 30_000) {
      for (const l of lines) {
        const m = re.exec(l);
        if (m) return Promise.resolve(m);
      }
      return new Promise((resolve, reject) => {
        const w = { re, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`timeout waiting for ${re}; probe output so far:\n${lines.join("\n")}`));
          }
        }, timeoutMs);
      });
    },
  };
}

interface AdoptResult {
  ownerPid: number;
  childPid: number;
  leafPid: number;
  childContained: boolean | null;
  leafContained: boolean | null;
  status: { active: boolean; guarantee: string; reason?: string };
}

describe.skipIf(!IS_WINDOWS)("windows job object: adopt descendants spawned before setup", () => {
  for (const childSpawn of ["detached", "attached"]) {
    test(`child (${childSpawn} plain Bun.spawn) and its grandchild are adopted and die with the owner`, async () => {
      const probe = startProbe(["adopt", childSpawn]);
      const r: AdoptResult = JSON.parse((await probe.waitFor(/^RESULT (.*)$/))[1]!);
      expect(r.status).toMatchObject({ active: true, guarantee: "kernel" });
      expect(r.status.reason).toBeUndefined(); // no descendant failed adoption
      expect(r.childContained).toBe(true);
      expect(r.leafContained).toBe(true);
      expect(pidAlive(r.childPid)).toBe(true);
      expect(pidAlive(r.leafPid)).toBe(true);

      await hardKill(r.ownerPid);
      expect(await aliveAfter(r.leafPid, 5_000)).toBe(false);
      expect(await aliveAfter(r.childPid, 5_000)).toBe(false);
    }, T);
  }

  test("CONTROL: with BUN_SPAWN_CLEANUP_DISABLE=1 the same tree survives the owner's hard kill", async () => {
    const probe = startProbe(["adopt", "detached"], true);
    const r: AdoptResult = JSON.parse((await probe.waitFor(/^RESULT (.*)$/))[1]!);
    expect(r.status.active).toBe(false);
    expect(r.childContained).toBeNull();

    await hardKill(r.ownerPid);
    await sleep(1_500);
    expect(pidAlive(r.childPid)).toBe(true);
    expect(pidAlive(r.leafPid)).toBe(true); // leaked; afterEach reaps both
  }, T);
});

describe.skipIf(!IS_WINDOWS)("windows job object: killTree() with no argument", () => {
  test("kills every child and grandchild, leaves the owner alive and active", async () => {
    const probe = startProbe(["killall"]);
    const p: { ownerPid: number; pids: Array<{ child: number; leaf: number }> } = JSON.parse(
      (await probe.waitFor(/^PIDS (.*)$/))[1]!,
    );
    const all = p.pids.flatMap((x) => [x.child, x.leaf]);
    expect(all).toHaveLength(4);

    const result = JSON.parse((await probe.waitFor(/^KILLALL (.*)$/))[1]!);
    expect(result).toMatchObject({ tracked: true });
    expect(result.detail).toMatch(/^terminated \d+ of \d+ job member\(s\)$/);

    for (const pid of all) expect(await aliveAfter(pid, 5_000)).toBe(false);

    const after = JSON.parse((await probe.waitFor(/^AFTER (.*)$/))[1]!);
    expect(after).toMatchObject({ active: true, guarantee: "kernel" });
    expect(pidAlive(p.ownerPid)).toBe(true);
  }, T);
});
