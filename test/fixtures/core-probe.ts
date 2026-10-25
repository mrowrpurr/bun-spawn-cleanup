/**
 * core-probe.ts <scenario>
 *
 * Exercises the side-effect-free `/core` entry in a SEPARATE process and prints one JSON
 * object. Each scenario is one row of the "rules, enforced by throwing" table:
 *
 *   core            import /core only: status inactive, spawn throws, configure, spawn works,
 *                   second configure throws
 *   core-disable    configure({ disable: true }) with no env: status inactive by option;
 *                   spawn still works as passthrough
 *   option-wins     BUN_SPAWN_CLEANUP_DISABLE=1 in env but configure({ disable: false }):
 *                   the option wins and containment is set up
 *   root-then-core  static root import, then /core configure: throws with the root message
 *   core-then-root  /core configure, then dynamic import of the root: rejects
 *   killtree-unconfigured
 *                   killTree on a plain Bun.spawn child before configure: tracked false,
 *                   child killed; killTree() with no argument: tracked false; and the
 *                   process stays unconfigured after both
 */
import { configureSpawnCleanup, killTree, spawn, status } from "../../src/core.ts";
import { configuredBy, isConfigured } from "../../src/internal.ts";

const scenario = process.argv[2] ?? "core";
const out: Record<string, unknown> = { scenario, platform: process.platform };

function attempt(fn: () => unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function spawnEcho(): Promise<{ text: string; exit: number }> {
  const p = spawn([process.execPath, "-e", "console.log('hi')"], { stdout: "pipe" });
  return { text: await p.stdout.text(), exit: await p.exited };
}

switch (scenario) {
  case "core": {
    out.configuredBefore = isConfigured();
    out.statusBefore = status();
    out.spawnBefore = attempt(() => spawn([process.execPath, "-e", "0"]));
    out.configure = attempt(() => configureSpawnCleanup());
    out.configuredBy = configuredBy();
    out.statusAfter = status();
    out.echo = await spawnEcho();
    out.configureAgain = attempt(() => configureSpawnCleanup());
    break;
  }
  case "core-disable": {
    out.configure = attempt(() => configureSpawnCleanup({ disable: true }));
    out.statusAfter = status();
    out.echo = await spawnEcho();
    break;
  }
  case "option-wins": {
    out.envDisable = process.env.BUN_SPAWN_CLEANUP_DISABLE ?? null;
    out.configure = attempt(() => configureSpawnCleanup({ disable: false }));
    out.statusAfter = status();
    break;
  }
  case "root-then-core": {
    await import("../../src/index.ts");
    out.configuredBy = configuredBy();
    out.configure = attempt(() => configureSpawnCleanup());
    out.statusAfter = status();
    break;
  }
  case "core-then-root": {
    configureSpawnCleanup();
    out.configuredBy = configuredBy();
    try {
      await import("../../src/index.ts");
      out.rootImport = { ok: true };
    } catch (e) {
      out.rootImport = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    out.statusAfter = status();
    break;
  }
  case "killtree-unconfigured": {
    const p = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], { stdout: "ignore" });
    out.kill = killTree(p);
    out.exit = await p.exited;
    out.killAllUnconfigured = killTree(); // no argument: owner-wide; must not configure either
    out.configuredAfter = isConfigured();
    out.statusAfter = status();
    break;
  }
  default:
    throw new Error(`unknown scenario ${scenario}`);
}

console.log(JSON.stringify(out));
