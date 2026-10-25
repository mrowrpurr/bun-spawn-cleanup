/**
 * status-probe.ts
 *
 * Runs one trivial spawn through the library in a SEPARATE process and prints
 * `cleanupStatus()` as JSON. Test files call this synchronously at load time to learn which
 * mechanism the host supports (e.g. whether Linux cgroup v2 is writable) and skip suites
 * that cannot run here, without the test runner ever joining a job or cgroup itself.
 */
import { status as cleanupStatus, spawn } from "../../src/index.ts";

const p = spawn([process.execPath, "-e", "0"], { stdout: "ignore", stderr: "ignore" });
await p.exited;
console.log(JSON.stringify(cleanupStatus()));
