/**
 * Helpers for the macOS suites. Every owner a darwin test starts gets its own scratch
 * ledger directory (BUN_SPAWN_CLEANUP_DIR), so real ledgers are never touched, sweeps in one
 * suite never see another suite's owners, and the suite can find and stop its daemon.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DAEMON_ENV, LINEAGE_MS_ENV } from "../src/platform/darwin/index.ts";
import { DIR_ENV, liveDaemon } from "../src/platform/darwin/ledger.ts";
import { procEnv, SIGKILL, sendSignal, uniqueIds } from "../src/platform/darwin/ffi.ts";

export const IS_DARWIN = process.platform === "darwin";
const CLI = join(import.meta.dir, "..", "bin", "cli.ts");

export function scratchLedgerDir(): string {
  return mkdtempSync(join(tmpdir(), "bsc-ledgers-"));
}

/** Env for an owner using `dir`, with the daemon on (`auto`) or off, and optional extras. */
export function ownerEnv(dir: string, daemon: "auto" | "off", extra: Record<string, string> = {}): Record<string, string> {
  return { [DIR_ENV]: dir, [DAEMON_ENV]: daemon, ...extra };
}

export { LINEAGE_MS_ENV };

/**
 * SIGKILL every daemon for `dir` and wait (2 s max) until they are gone: the one in
 * daemon.json, plus any `bsc-daemon` whose env names `dir` (one still starting up, or one
 * that lost the lock race and is about to exit).
 */
export function stopDaemon(dir: string): void {
  const victims = new Map<number, bigint>();
  const d = liveDaemon(dir);
  if (d) victims.set(d.pid, BigInt(d.uid));
  const ps = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe" }).stdout.toString();
  for (const m of ps.matchAll(/^\s*(\d+)\s+bsc-daemon\b/gm)) {
    const pid = Number(m[1]);
    const ids = uniqueIds(pid);
    if (ids && procEnv(pid)?.includes(`${DIR_ENV}=${dir}`)) victims.set(pid, ids.uid);
  }
  for (const pid of victims.keys()) sendSignal(pid, SIGKILL);
  for (const [pid, uid] of victims) for (let i = 0; i < 100 && uniqueIds(pid)?.uid === uid; i++) Bun.sleepSync(20);
}

/** Wait until a daemon serves `dir` (it starts asynchronously from the owner). */
export async function waitForDaemon(dir: string, timeoutMs = 10_000): Promise<{ pid: number; uid: string } | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = liveDaemon(dir);
    if (d) return d;
    await Bun.sleep(50);
  }
  return undefined;
}

/** Ledger files (live or stale) currently in `dir`. */
export function ledgerFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => /^\d+-\d+(t\d+)?\.json/.test(n));
  } catch {
    return [];
  }
}

/** Run `bun bin/cli.ts <args>` against `dir`. */
export function runCli(dir: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([process.execPath, CLI, ...args], {
    env: { ...(process.env as Record<string, string>), [DIR_ENV]: dir },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** Stop the daemon and delete the directory. For afterAll. */
export function disposeLedgerDir(dir: string): void {
  stopDaemon(dir);
  rmSync(dir, { recursive: true, force: true });
}

let runDir: string | undefined;

/**
 * Pidfile in a per-test dir under this run's own scratch root. Every fixture process of a
 * darwin test has that root in its command line (leaf.ts gets the pidfile as argv), which
 * is what lets `reapStrays` find intermediates without touching anything else.
 */
export function darwinPidfile(): string {
  runDir ??= mkdtempSync(join(tmpdir(), "bsc-darwin-run-"));
  return join(mkdtempSync(join(runDir, "p-")), "leaf.pid");
}

/**
 * Kill every process whose command line contains THIS run's scratch root (intermediates
 * such as the `bun -e` in the bun-child scenario are not known to reapAll), and remove the
 * launchd jobs a launchctl scenario of this run left behind. For afterEach.
 */
export function reapStrays(): void {
  if (!runDir) return;
  const r = Bun.spawnSync(["ps", "-axo", "pid=,command="], { stdout: "pipe" });
  for (const line of r.stdout.toString().split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid || !m[2]!.includes(runDir)) continue;
    sendSignal(Number(m[1]), SIGKILL);
  }
  const prefix = `bsc-test.${basename(runDir)}.`;
  const jobs = Bun.spawnSync(["launchctl", "list"], { stdout: "pipe" }).stdout.toString();
  for (const label of jobs.split(/\s+/).filter((w) => w.startsWith(prefix))) Bun.spawnSync(["launchctl", "remove", label]);
}

/** Remove this run's scratch root (preload's global afterAll, after every darwin file). */
export function disposeRunDir(): void {
  reapStrays();
  if (runDir) rmSync(runDir, { recursive: true, force: true });
  runDir = undefined;
}

/**
 * Wait until the daemon for `dir` lists `ownerPid`'s ledger among the owners whose NOTE_EXIT
 * it has armed (daemon.json `owners`), i.e. a SIGKILL of the owner will be seen.
 */
export async function waitForArmed(dir: string, ownerPid: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (liveDaemon(dir)?.owners?.some((k) => k.startsWith(`${ownerPid}-`))) return true;
    await Bun.sleep(25);
  }
  return false;
}
