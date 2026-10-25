/**
 * api-probe.ts
 *
 * Exercises the public API in a SEPARATE process (so the test runner itself never joins a
 * job) and prints one JSON object with everything the api test asserts on.
 */
import { backend, isContained } from "../../src/internal.ts";
import { status as cleanupStatus, killTree, spawn } from "../../src/index.ts";

const statusBefore = cleanupStatus();

const echo = spawn([process.execPath, "-e", "console.log('hi')"], { stdout: "pipe" });
const first = cleanupStatus();
const second = cleanupStatus();
const echoText = await echo.stdout.text();
const echoExit = await echo.exited;

const objForm = spawn({ cmd: [process.execPath, "-e", "process.exit(7)"], stdout: "ignore" });
const objFormExit = await objForm.exited;

const sleeper = spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], { stdout: "ignore" });
const sleeperContained = isContained(sleeper.pid);
const sleeperKill = killTree(sleeper);
const sleeperExit = await sleeper.exited;

const unknownKill = killTree(999_999_999);

console.log(
  JSON.stringify({
    platform: process.platform,
    backendName: backend.name,
    backendPlatform: backend.platform,
    statusBefore,
    first,
    second,
    status: cleanupStatus(),
    echoPid: echo.pid,
    echoText,
    echoExit,
    objFormExit,
    sleeperContained: sleeperContained ?? null,
    sleeperKill,
    sleeperExit,
    unknownKill,
  }),
);
