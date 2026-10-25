/**
 * windows-adopt-probe.ts <adopt|killall> <scratch-dir> [detached|attached]
 *
 * Windows only. Uses `/core` so setup happens exactly where this file says, never at import.
 *
 *   adopt     Start child.ts with PLAIN `Bun.spawn` (detached by default, so Bun's own
 *             per-process job does not already own it), let it start a leaf grandchild via
 *             `Bun.spawn({ detached: true })`, and only THEN call configureSpawnCleanup().
 *             Prints `RESULT {ownerPid, childPid, leafPid, childContained, leafContained, status}`.
 *             `attached` spawns the child without `detached`, to observe how adoption fares
 *             against a child that is already in Bun's job.
 *   killall   configureSpawnCleanup(), then two children through the library's spawn, each
 *             with a leaf (`detached` scenario and `cmd-start`, whose leaf is orphaned).
 *             Prints `PIDS {...}`, then `KILLALL <json>` with killTree()'s result, then
 *             `AFTER <status json>` half a second later, proving the owner survived.
 *
 * Then lives forever; the test hard-kills it.
 */
import { join } from "node:path";
import { configureSpawnCleanup, killTree, spawn, status } from "../../src/core.ts";
import { isContained } from "../../src/internal.ts";
import { readLines } from "../helpers.ts";

const mode = process.argv[2] ?? "";
const dir = process.argv[3] ?? "";
const childSpawn = process.argv[4] ?? "detached";
if (!mode || !dir) {
  console.error("usage: windows-adopt-probe.ts <adopt|killall> <scratch-dir> [detached|attached]");
  process.exit(2);
}

const say = (line: string) => process.stdout.write(line + "\n");
const CHILD = join(import.meta.dir, "child.ts");

/** Resolve the leaf pid from child.ts's `LEAF <pid>` line, then keep draining its stdout. */
async function leafOf(stdout: ReadableStream<Uint8Array>): Promise<number> {
  const lines = readLines(stdout);
  for await (const line of lines) {
    const m = /^LEAF (\d+)$/.exec(line);
    if (m) {
      (async () => {
        for await (const _ of lines);
      })().catch(() => {});
      return Number(m[1]);
    }
    if (line.startsWith("ERROR")) throw new Error(line);
  }
  throw new Error("child exited before reporting its leaf");
}

if (mode === "adopt") {
  const child = Bun.spawn([process.execPath, CHILD, "detached", join(dir, "leaf.pid"), "stay"], {
    stdio: ["ignore", "pipe", "inherit"],
    detached: childSpawn === "detached",
  });
  say(`CHILD ${child.pid}`);
  const leafPid = await leafOf(child.stdout);
  say(`LEAF ${leafPid}`);
  const configured = configureSpawnCleanup();
  say(
    `RESULT ${JSON.stringify({
      ownerPid: process.pid,
      childPid: child.pid,
      leafPid,
      childContained: isContained(child.pid) ?? null,
      leafContained: isContained(leafPid) ?? null,
      status: configured,
    })}`,
  );
} else if (mode === "killall") {
  configureSpawnCleanup();
  const scenarios = ["detached", "cmd-start"];
  const pids: Array<{ child: number; leaf: number }> = [];
  for (const [i, scenario] of scenarios.entries()) {
    const sub = join(dir, `k${i}`);
    await Bun.write(join(sub, ".keep"), "");
    const child = spawn([process.execPath, CHILD, scenario, join(sub, "leaf.pid"), "stay"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    say(`CHILD ${child.pid}`);
    const leaf = await leafOf(child.stdout);
    say(`LEAF ${leaf}`);
    pids.push({ child: child.pid, leaf });
  }
  say(`PIDS ${JSON.stringify({ ownerPid: process.pid, pids })}`);
  say(`KILLALL ${JSON.stringify(killTree())}`);
  await Bun.sleep(500);
  say(`AFTER ${JSON.stringify(status())}`);
} else {
  say(`ERROR unknown mode ${mode}`);
  process.exit(2);
}

setInterval(() => {}, 60_000);
