/**
 * darwin-core-probe.ts <scenario> <pidfile> [args...]
 *
 * macOS owner for the `/core` setup semantics (test/darwin-options.test.ts). Uses
 * `configureSpawnCleanup()` explicitly, at a moment the scenario picks:
 *
 *   adopt <pidfile>
 *       With PLAIN Bun.spawn (no library), start a child that starts a grandchild leaf,
 *       wait for the leaf, THEN configure. Prints
 *         PROBE {"ownerPid","childPid","leafPid","childContained","leafContained",
 *                "childUid","leafUid","ledgerLineage","status"}
 *       where ledgerLineage is the lineage of this owner's ledger read right after setup
 *       (before any timer tick could have grown it).
 *   killall <pidfile>
 *       Configure, then spawn two children through the library, each with a grandchild
 *       leaf (pidfiles <pidfile>.a and <pidfile>.b). Prints
 *         PIDS {"ownerPid","children":[..],"leaves":[..]}
 *   options <pidfile> <options-json>
 *       configureSpawnCleanup(<options-json>), then spawn one library child that starts its
 *       leaf only after 500 ms (so only a lineage tick, not track(), can see it). Prints
 *         STATUS <json>, OWNER <pid>, CHILD <pid>, LEAF <pid>
 *       It never calls isContained (that would scan and hide what the timer did).
 *
 * Commands on stdin (all scenarios):
 *   killall          killTree() with no argument, prints KILLALL <json>
 *   spawn            spawn a sleeper through the library, prints SPAWNED <pid> contained=<bool>
 *   killtree <pid>   killTree(pid) of a sleeper from `spawn`, prints KILLTREE <json>
 *   status           prints STATUS <json>
 *   exit             clean process.exit(0)
 *
 * Internal role: `_child <pidfile> [delayMs]` starts leaf.ts <pidfile> (plain Bun.spawn)
 * after delayMs and idles.
 */
import { join } from "node:path";
import { configureSpawnCleanup, killTree, spawn, status } from "../../src/core.ts";
import { isContained } from "../../src/internal.ts";
import { uniqueIds } from "../../src/platform/darwin/ffi.ts";
import { ledgerDir, ledgerPath, ownerKey, readLedger } from "../../src/platform/darwin/ledger.ts";

const role = process.argv[2] ?? "";
const pidfile = process.argv[3] ?? "";
const SELF = import.meta.path;
const LEAF = join(import.meta.dir, "leaf.ts");

if (!role || !pidfile) {
  console.error("usage: darwin-core-probe.ts <adopt|killall|options|_child> <pidfile> [args...]");
  process.exit(2);
}

function say(line: string): void {
  process.stdout.write(line + "\n");
}


async function waitForPid(file: string, timeoutMs = 20_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = Bun.file(file);
    if (await f.exists()) {
      const text = (await f.text()).trim();
      if (/^\d+$/.test(text)) return Number(text);
    }
    await Bun.sleep(25);
  }
  say(`ERROR pidfile ${file} never appeared`);
  process.exit(3);
}

const uidOf = (pid: number) => {
  const u = uniqueIds(pid)?.uid;
  return u === undefined ? null : String(u);
};

async function main(): Promise<void> {
  const childArgs = (file: string, delay = 0) => [process.execPath, SELF, "_child", file, String(delay)];

  switch (role) {
    case "adopt": {
      // Before setup, by plain Bun.spawn: the library must adopt these at configure time.
      const child = Bun.spawn(childArgs(pidfile), { stdio: ["ignore", "ignore", "ignore"] });
      const leafPid = await waitForPid(pidfile);
      const st = configureSpawnCleanup();
      const self = uniqueIds(process.pid);
      const ledger = self ? readLedger(ledgerPath(ledgerDir(), ownerKey(process.pid, self.uid))) : undefined;
      const out = {
        ownerPid: process.pid,
        childPid: child.pid,
        leafPid,
        childUid: uidOf(child.pid),
        leafUid: uidOf(leafPid),
        ledgerLineage: ledger?.lineage ?? null,
        childContained: isContained(child.pid),
        leafContained: isContained(leafPid),
        status: st,
      };
      say(`PROBE ${JSON.stringify(out)}`);
      break;
    }
    case "killall": {
      configureSpawnCleanup();
      const children = ["a", "b"].map((s) => spawn(childArgs(`${pidfile}.${s}`), { stdio: ["ignore", "ignore", "ignore"] }));
      const leaves = [await waitForPid(`${pidfile}.a`), await waitForPid(`${pidfile}.b`)];
      say(`PIDS ${JSON.stringify({ ownerPid: process.pid, children: children.map((c) => c.pid), leaves })}`);
      break;
    }
    case "options": {
      const options = JSON.parse(process.argv[4] ?? "{}");
      configureSpawnCleanup(options);
      say(`STATUS ${JSON.stringify(status())}`);
      say(`OWNER ${process.pid}`);
      const child = spawn(childArgs(pidfile, 500), { stdio: ["ignore", "ignore", "ignore"] });
      say(`CHILD ${child.pid}`);
      say(`LEAF ${await waitForPid(pidfile)}`);
      break;
    }
    default:
      say(`ERROR unknown scenario ${role}`);
      process.exit(2);
  }

  const extra = new Map<number, Bun.Subprocess>();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const [cmd = "", arg] = buf.slice(0, i).trim().split(/\s+/);
      buf = buf.slice(i + 1);
      switch (cmd) {
        case "killall":
          say(`KILLALL ${JSON.stringify(killTree())}`);
          break;
        case "spawn": {
          const p = spawn([process.execPath, "-e", "setInterval(() => {}, 60000)"], { stdio: ["ignore", "ignore", "ignore"] });
          extra.set(p.pid, p);
          say(`SPAWNED ${p.pid} contained=${isContained(p.pid)}`);
          break;
        }
        case "killtree":
          say(`KILLTREE ${JSON.stringify(killTree(extra.get(Number(arg)) ?? Number(arg)))}`);
          break;
        case "status":
          say(`STATUS ${JSON.stringify(status())}`);
          break;
        case "exit":
          process.exit(0);
        case "":
          break;
        default:
          say(`ERROR unknown command ${cmd}`);
      }
    }
  }
  setInterval(() => {}, 60_000);
}

// Last, so every const above is initialised before main() runs.
if (role === "_child") {
  const delay = Number(process.argv[4] ?? 0);
  if (delay > 0) await Bun.sleep(delay);
  Bun.spawn([process.execPath, LEAF, pidfile], { stdio: ["ignore", "ignore", "ignore"] });
  setInterval(() => {}, 60_000);
} else {
  await main();
}

