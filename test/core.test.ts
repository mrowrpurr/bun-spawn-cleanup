/**
 * The `/core` entry: no side effect at import, explicit one-shot `configureSpawnCleanup()`,
 * and the mixing rules between `/core` and the root entry. Platform-neutral: asserts on
 * configure/throw behaviour and status shape, never on reaping (the platform suites do that).
 *
 * Every scenario runs in its own process (core-probe.ts) so the runner never joins a job.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DISABLE_ENV } from "../src/internal.ts";

type Attempt = { ok: true; value: unknown } | { ok: false; error: string };
interface Status {
  active: boolean;
  reason?: string;
  backend: string;
  guarantee: string;
}

async function probe(scenario: string, extraEnv: Record<string, string> = {}): Promise<Record<string, any>> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...extraEnv };
  if (!(DISABLE_ENV in extraEnv)) delete env[DISABLE_ENV];
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "core-probe.ts"), scenario], {
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [out, err, code] = await Promise.all([p.stdout.text(), p.stderr.text(), p.exited]);
  expect(code, err).toBe(0);
  return JSON.parse(out.trim());
}

describe("core entry", () => {
  test("import has no side effect; spawn throws until configureSpawnCleanup(); configure is one-shot", async () => {
    const r = await probe("core");
    expect(r.configuredBefore).toBe(false);
    expect((r.statusBefore as Status).active).toBe(false);
    expect((r.statusBefore as Status).reason).toContain("not configured");

    const spawnBefore = r.spawnBefore as Attempt;
    expect(spawnBefore.ok).toBe(false);
    if (!spawnBefore.ok) expect(spawnBefore.error).toContain("before configureSpawnCleanup()");

    const configure = r.configure as Attempt;
    expect(configure.ok).toBe(true);
    expect(r.configuredBy).toBe("core");
    expect(r.statusAfter).toEqual(configure.ok ? configure.value : null);
    if (process.platform === "win32") expect((r.statusAfter as Status)).toMatchObject({ active: true, guarantee: "kernel" });

    expect(r.echo).toEqual({ text: "hi\n", exit: 0 });

    const again = r.configureAgain as Attempt;
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error).toContain("already ran");
  }, 30_000);

  test("configureSpawnCleanup({ disable: true }) turns containment off; spawn is a passthrough", async () => {
    const r = await probe("core-disable");
    expect((r.configure as Attempt).ok).toBe(true);
    expect((r.statusAfter as Status).active).toBe(false);
    expect((r.statusAfter as Status).reason).toContain("disable: true");
    expect(r.echo).toEqual({ text: "hi\n", exit: 0 });
  }, 30_000);

  test("an option wins over its env var", async () => {
    const r = await probe("option-wins", { [DISABLE_ENV]: "1" });
    expect(r.envDisable).toBe("1");
    expect((r.configure as Attempt).ok).toBe(true);
    const s = r.statusAfter as Status;
    // Not disabled: either active, or inactive for an OS reason that is not the env var.
    if (!s.active) expect(s.reason ?? "").not.toContain(DISABLE_ENV);
    if (process.platform === "win32") expect(s.active).toBe(true);
  }, 30_000);

  test("root import then /core configure throws and names the root import", async () => {
    const r = await probe("root-then-core");
    expect(r.configuredBy).toBe("root");
    const c = r.configure as Attempt;
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error).toContain('importing "bun-spawn-cleanup" does it for you');
    if (process.platform === "win32") expect((r.statusAfter as Status).active).toBe(true);
  }, 30_000);

  test("/core configure then a dynamic root import rejects", async () => {
    const r = await probe("core-then-root");
    expect(r.configuredBy).toBe("core");
    expect(r.rootImport.ok).toBe(false);
    expect(r.rootImport.error).toContain('already ran from "bun-spawn-cleanup/core"');
    if (process.platform === "win32") expect((r.statusAfter as Status).active).toBe(true);
  }, 30_000);

  test("killTree before configure falls back to kill() and does not configure the process", async () => {
    const r = await probe("killtree-unconfigured");
    expect(r.kill).toMatchObject({ tracked: false });
    expect(r.exit).not.toBe(0);
    expect(r.killAllUnconfigured).toMatchObject({ tracked: false, detail: "not configured" });
    expect(r.configuredAfter).toBe(false);
    expect((r.statusAfter as Status).active).toBe(false);
  }, 30_000);
});
