/**
 * owner.ts <scenario> <pidfile> <stay|exit>
 *
 * The process under test. Uses the library's `spawn` to launch child.ts, forwards the
 * child's event lines, and reacts to one-word commands on stdin:
 *
 *   killtree [pid]  killTree(child) or killTree(pid), then prints KILLTREE <json>
 *   spawn      spawn one more sleeper through the library, prints SPAWNED <pid>
 *   status     prints STATUS <json> again (cleanupStatus() now)
 *   exit       clean process.exit(0)
 *   throw      uncaught exception
 *
 * Lines it prints:
 *   STATUS <json>                 cleanupStatus() after the first spawn
 *   OWNER <pid>
 *   CHILD <pid> contained=<bool>
 *   LEAF <pid> contained=<bool|undefined>   (re-emitted from the child with containment info)
 *   <any other child line>        forwarded verbatim
 *   LISTENING <signals>           only with OWNER_LISTEN set (see below)
 *
 * Opt-in env: OWNER_LISTEN=SIGTERM[,SIGINT...] installs a no-op `process.on(sig)` listener
 * for each listed signal BEFORE the first spawn (an app that handles the signal itself and
 * keeps running), and prints `LISTENING <signals>` after the CHILD line.
 */
import { join } from "node:path";
import { configureSpawnCleanup, status as cleanupStatus, killTree, spawn } from "../../src/core.ts";
import { isContained } from "../../src/internal.ts";

const scenario = process.argv[2] ?? "";
const pidfile = process.argv[3] ?? "";
const mode = process.argv[4] ?? "stay";
if (!scenario || !pidfile) {
  console.error("usage: owner.ts <scenario> <pidfile> <stay|exit>");
  process.exit(2);
}

function say(line: string): void {
  process.stdout.write(line + "\n");
}

/** Complete lines only, carrying partial lines across chunks. */
async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.search(/\r?\n/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === "\r" ? 2 : 1));
      if (line) yield line;
    }
  }
  if (buf) yield buf;
}

const listen = (process.env.OWNER_LISTEN ?? "").split(",").filter(Boolean) as NodeJS.Signals[];
for (const sig of listen) process.on(sig, () => {});

// Setup happens here, after the listeners above, so a listener installed BEFORE setup is what
// the darwin signal tests exercise (the root entry would configure at import instead).
configureSpawnCleanup();

const child = spawn([process.execPath, join(import.meta.dir, "child.ts"), scenario, pidfile, mode], {
  stdio: ["ignore", "pipe", "inherit"],
});
say(`STATUS ${JSON.stringify(cleanupStatus())}`);
say(`OWNER ${process.pid}`);
say(`CHILD ${child.pid} contained=${isContained(child.pid)}`);
if (listen.length) say(`LISTENING ${listen.join(",")}`);

(async () => {
  for await (const line of readLines(child.stdout)) {
    const m = /^LEAF (\d+)$/.exec(line);
    if (m) say(`LEAF ${m[1]} contained=${isContained(Number(m[1]))}`);
    else say(line);
  }
})();

const extra = new Map<number, Bun.Subprocess>();

(async () => {
  for await (const raw of readLines(Bun.stdin.stream())) {
    const [cmd = "", arg] = raw.trim().split(/\s+/);
    switch (cmd) {
      case "killtree": {
        const target = arg ? (extra.get(Number(arg)) ?? Number(arg)) : child;
        say(`KILLTREE ${JSON.stringify(killTree(target))}`);
        break;
      }
      case "spawn": {
        const p = spawn([process.execPath, "-e", "setInterval(() => {}, 60000)"], { stdio: ["ignore", "ignore", "ignore"] });
        extra.set(p.pid, p);
        say(`SPAWNED ${p.pid}`);
        break;
      }
      case "status":
        say(`STATUS ${JSON.stringify(cleanupStatus())}`);
        break;
      case "exit":
        process.exit(0);
      case "throw":
        setTimeout(() => {
          throw new Error("owner fixture: deliberate uncaught throw");
        }, 0);
        break;
      case "":
        break;
      default:
        say(`ERROR unknown command ${raw}`);
    }
  }
})();

setInterval(() => {}, 60_000);
