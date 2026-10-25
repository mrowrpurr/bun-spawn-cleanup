/**
 * linux-owner.ts
 *
 * Owner fixture for the Linux adopt / killAll / supervisor-restart / subreaper tests. Uses
 * `/core`, so setup happens exactly where this file calls `configureSpawnCleanup()`.
 * Every long-lived process it creates is a `bun -e` sleeper, so the runner's `reapAll()`
 * (which only kills processes named bun) can clean up after a failing test.
 *
 * Env: LINUX_OWNER_PRE=1 builds a plain `Bun.spawn` child + grandchild BEFORE setup, then
 * prints `PRE <child> <grandchild>` and, after setup, `ADOPTED <child> <bool> <grandchild>
 * <bool>` (isContained of each).
 *
 * Always prints `STATUS <json>` and `OWNER <pid>` after setup, then answers stdin commands:
 *   tree lib|plain   TREE <child> <grandchild>: `sh` that backgrounds a sleeper and execs
 *                    into another, started by the library's spawn or by plain Bun.spawn
 *   orphan           ORPHAN <pid> <ppid>: plain Bun.spawn double fork; the sleeper's parent
 *                    has exited by the time this prints (ppid is whoever adopted it)
 *   slowsh           SLOWSH <sh> <grandchild>: library spawn of `sh` that backgrounds a
 *                    sleeper and exits 1.5 s later
 *   killall          KILLALL <json>: killTree() with no argument
 *   killtree <pid>   KILLTREE <json>: killTree(proc) for a pid this fixture spawned
 *   env              ENV <json>: stdout of `env` spawned by the library with env { BSC_ONLY: "1" }
 *   status           STATUS <json>
 *   exit             process.exit(0)
 */
import { configureSpawnCleanup, killTree, spawn, status } from "../../src/core.ts";
import { isContained } from "../../src/internal.ts";

const bun = process.execPath;
const SLEEPER = "setInterval(() => {}, 1e9)";
const say = (line: string) => process.stdout.write(line + "\n");

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) yield line;
    }
  }
  if (buf.trim()) yield buf.trim();
}

/** First line of a child's stdout (the pid its shell echoed). */
async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  for await (const line of readLines(stream)) return line;
  return "";
}

/** sh backgrounds one sleeper (the grandchild), echoes its pid, and execs into another (the child). */
const TREE_SCRIPT = `"$0" -e '${SLEEPER}' </dev/null >/dev/null 2>&1 & echo "$!"; exec "$0" -e '${SLEEPER}' </dev/null >/dev/null`;

const procs = new Map<number, Bun.Subprocess>();

async function tree(viaLibrary: boolean): Promise<[number, number]> {
  const opts = { stdin: "ignore", stdout: "pipe", stderr: "ignore" } as const;
  const p = viaLibrary ? spawn(["sh", "-c", TREE_SCRIPT, bun], opts) : Bun.spawn(["sh", "-c", TREE_SCRIPT, bun], opts);
  procs.set(p.pid, p);
  const grandchild = Number(await firstLine(p.stdout));
  return [p.pid, grandchild];
}

function ppidOf(pid: number): number | undefined {
  try {
    const stat = require("node:fs").readFileSync(`/proc/${pid}/stat`, "latin1") as string;
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return undefined;
  }
}

if (process.env.LINUX_OWNER_PRE === "1") {
  const [c, g] = await tree(false);
  say(`PRE ${c} ${g}`);
  configureSpawnCleanup();
  say(`ADOPTED ${c} ${isContained(c)} ${g} ${isContained(g)}`);
} else {
  configureSpawnCleanup();
}
say(`STATUS ${JSON.stringify(status())}`);
say(`OWNER ${process.pid}`);

for await (const raw of readLines(Bun.stdin.stream())) {
  const [cmd = "", arg] = raw.split(/\s+/);
  try {
    switch (cmd) {
      case "tree": {
        const [c, g] = await tree(arg !== "plain");
        say(`TREE ${c} ${g}`);
        break;
      }
      case "orphan": {
        const p = Bun.spawn(["sh", "-c", `( "$0" -e '${SLEEPER}' </dev/null >/dev/null 2>&1 & echo "$!" )`, bun], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        const leaf = Number((await p.stdout.text()).trim());
        await p.exited;
        say(`ORPHAN ${leaf} ${ppidOf(leaf)}`);
        break;
      }
      case "slowsh": {
        const p = spawn(["sh", "-c", `"$0" -e '${SLEEPER}' </dev/null >/dev/null 2>&1 & echo "$!"; sleep 1.5`, bun], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
        });
        procs.set(p.pid, p);
        say(`SLOWSH ${p.pid} ${Number(await firstLine(p.stdout))}`);
        break;
      }
      case "killall":
        say(`KILLALL ${JSON.stringify(killTree())}`);
        break;
      case "killtree": {
        const pid = Number(arg);
        say(`KILLTREE ${JSON.stringify(killTree(procs.get(pid) ?? pid))}`);
        break;
      }
      case "env": {
        const envBin = Bun.which("env") ?? "/usr/bin/env";
        const p = spawn([envBin], { env: { BSC_ONLY: "1" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        say(`ENV ${JSON.stringify(await p.stdout.text())}`);
        break;
      }
      case "status":
        say(`STATUS ${JSON.stringify(status())}`);
        break;
      case "exit":
        process.exit(0);
      default:
        say(`ERROR unknown command ${raw}`);
    }
  } catch (e) {
    say(`ERROR ${cmd}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
setInterval(() => {}, 60_000);
