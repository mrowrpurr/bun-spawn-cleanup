/**
 * darwin-worker-owner.ts <pidfile>
 *
 * macOS Worker case. The main thread spawns once through the library (so it owns the
 * process-wide exit hook); a Worker then spawns leaf.ts through the library (a thread-scoped
 * owner with its own `<pid>-<uid>t<id>.json` ledger) and is `terminate()`d, which runs no
 * exit hook in the Worker. Prints `LEAF <pid>`, then `TERMINATED`; then `exit` on stdin
 * makes the process exit cleanly.
 */
import { join } from "node:path";
import { spawn } from "../../src/index.ts";

const pidfile = process.argv[2]!;
const first = spawn([process.execPath, "-e", "0"], { stdio: ["ignore", "ignore", "ignore"] });
await first.exited;

const worker = new Worker(new URL("./darwin-worker.ts", import.meta.url).href);
const leafPid = await new Promise<number>((resolve) => {
  worker.onmessage = (e) => resolve(e.data as number);
  worker.postMessage({ leaf: join(import.meta.dir, "leaf.ts"), pidfile });
});
console.log(`LEAF ${leafPid}`);
await worker.terminate();
console.log("TERMINATED");

for await (const line of console) if (line.trim() === "exit") process.exit(0);
