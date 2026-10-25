/**
 * bun-spawn-cleanup — a `Bun.spawn` drop-in whose children (and grandchildren, and so on)
 * are reaped when THIS process exits or is killed, by any means.
 *
 *   import { spawn, killTree, status } from "bun-spawn-cleanup";
 *   const proc = spawn(["cmd", "/c", "start", "/b", "ping", "-t", "127.0.0.1"]);
 *   // ... later, or never: when this process dies the whole subtree dies with it.
 *   killTree(proc); // kill just that subtree now
 *
 * IMPORTING THIS MODULE IS THE SETUP. It runs `configureSpawnCleanup()` as a side effect, so
 * from the import line on every process this process creates, by any API, is contained:
 * on Windows the process joins a kill-on-close Job Object; on Linux it moves into its own
 * cgroup, starts a detached supervisor and applies a Landlock ruleset (so no descendant can
 * run setuid programs such as `sudo`, or signal outside the tree on 6.12+); on macOS nothing
 * yet. Static imports are hoisted, so this happens before any of your own code runs.
 *
 * Want to choose the moment, pass options, or stay side-effect free? Import
 * "bun-spawn-cleanup/core" instead and call `configureSpawnCleanup()` yourself. Do not mix
 * the two: a root import after a `/core` configure throws, and vice versa.
 *
 * Guarantee strength by platform — see `status().guarantee`:
 *   windows  kernel       Job Object + KILL_ON_JOB_CLOSE (implemented)
 *   linux    kernel       cgroup v2 + cgroup.kill via a detached supervisor (implemented);
 *            best-effort  PR_SET_CHILD_SUBREAPER + /proc parent links (+ env marker as a
 *                         second net) when no writable cgroup v2 exists
 *   darwin   best-effort  lineage ids + env marker + ledger; owner hooks + kqueue daemon (implemented)
 *
 * Containment is PROCESS-WIDE on every backend: everything this process starts by any API is
 * covered, and `spawn()` is byte-for-byte `Bun.spawn`.
 */
import { configureFromRoot } from "./state.ts";

configureFromRoot();

export { killTree, spawn, status } from "./core.ts";
export type { CleanupOptions, CleanupStatus, Guarantee, KillTreeResult, Platform } from "./core.ts";
