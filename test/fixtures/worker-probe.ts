/**
 * worker-probe.ts
 *
 * Landlock and no_new_privs are per-thread unless applied with TSYNC. This fixture creates
 * a Worker BEFORE setup (it uses `/core` so the root import does not configure first), then
 * configures, then has the Worker spawn a shell that tries to write its pid into the parent
 * cgroup's cgroup.procs. Prints one JSON line: `{ status, workerChild }` where workerChild
 * is "denied" or "ok".
 */
import { configureSpawnCleanup, status as cleanupStatus, spawn } from "../../src/core.ts";

const worker = new Worker(
  new URL(
    "data:text/javascript," +
      encodeURIComponent(`
        self.onmessage = async (e) => {
          const p = Bun.spawn(["sh", "-c", 'echo $$ > "' + e.data + '/cgroup.procs" 2>/dev/null && echo ok || echo denied'], { stdout: "pipe" });
          postMessage((await p.stdout.text()).trim());
        };`),
  ),
);
await Bun.sleep(200); // let the worker thread exist before the sandbox is applied

configureSpawnCleanup();
const first = spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
await first.exited;
const status = cleanupStatus();

const own = (await Bun.file("/proc/self/cgroup").text()).split("\n").find((l) => l.startsWith("0::"))!.slice(3).trim();
const parent = "/sys/fs/cgroup" + own.slice(0, own.lastIndexOf("/"));
worker.postMessage(parent);
const workerChild = await new Promise<string>((resolve) => (worker.onmessage = (e) => resolve(e.data)));
console.log(JSON.stringify({ status, workerChild }));
process.exit(0);
