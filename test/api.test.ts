/**
 * Cross-platform API surface. Runs everywhere; makes no claims about reaping (those live
 * in the per-platform test files) beyond "spawn is a faithful Bun.spawn".
 *
 * The probe runs in its own process so the `bun test` runner never joins a job.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DISABLE_ENV } from "../src/internal.ts";

interface Probe {
  platform: string;
  backendName: string;
  backendPlatform: string;
  statusBefore: { active: boolean; reason?: string };
  first: { active: boolean; guarantee: string; backend: string; reason?: string };
  second: Probe["first"];
  status: Probe["first"];
  echoPid: number;
  echoText: string;
  echoExit: number;
  objFormExit: number;
  sleeperContained: boolean | null;
  sleeperKill: { tracked: boolean };
  sleeperExit: number;
  unknownKill: { tracked: boolean };
}

async function runProbe(disable = false): Promise<Probe> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (disable) env[DISABLE_ENV] = "1";
  else delete env[DISABLE_ENV];
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "api-probe.ts")], {
    stdout: "pipe",
    stderr: "inherit",
    env,
  });
  const out = await p.stdout.text();
  expect(await p.exited).toBe(0);
  return JSON.parse(out.trim()) as Probe;
}

describe("api", () => {
  test("importing the root configures at import; status is stable and matches the host platform", async () => {
    const r = await runProbe();
    expect(r.statusBefore).toEqual(r.first); // configured by the import line, before any spawn
    expect(r.first).toEqual(r.second);
    expect(r.status).toEqual(r.first);
    expect(["kernel", "best-effort", "none"]).toContain(r.first.guarantee);
    expect(r.first.backend).toBe(r.backendName);
    if (!r.first.active) expect(typeof r.first.reason).toBe("string");

    const expected = { win32: "windows", linux: "linux", darwin: "darwin" }[r.platform] ?? "other";
    expect(r.backendPlatform).toBe(expected);
    if (r.platform === "win32") {
      expect(r.backendName).toBe("windows-job-object");
      expect(r.first.active).toBe(true);
    }
  }, 30_000);

  test("spawn behaves like Bun.spawn in both overload forms", async () => {
    const r = await runProbe();
    expect(r.echoPid).toBeGreaterThan(0);
    expect(r.echoText).toBe("hi\n");
    expect(r.echoExit).toBe(0);
    expect(r.objFormExit).toBe(7);
  }, 30_000);

  test("isContained and killTree reflect the backend's reach", async () => {
    const r = await runProbe();
    if (r.first.active) {
      expect(r.sleeperContained).toBe(true);
      if (r.platform === "win32") expect(r.sleeperKill.tracked).toBe(true);
    } else {
      expect(r.sleeperContained).toBeNull(); // undefined serializes as null
    }
    expect(r.sleeperExit).not.toBe(0);
    expect(r.unknownKill.tracked).toBe(false);
  }, 30_000);

  test("with BUN_SPAWN_CLEANUP_DISABLE=1 everything still works as a passthrough", async () => {
    const r = await runProbe(true);
    expect(r.first.active).toBe(false);
    expect(r.first.reason).toContain(DISABLE_ENV);
    expect(r.echoText).toBe("hi\n");
    expect(r.sleeperContained).toBeNull();
    expect(r.sleeperKill.tracked).toBe(false); // fell back to proc.kill()
    expect(r.sleeperExit).not.toBe(0);
  }, 30_000);
});
