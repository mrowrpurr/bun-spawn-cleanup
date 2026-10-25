/**
 * Test-run preload (bunfig.toml). macOS only: every owner a test starts would otherwise
 * write ledgers into, and auto-start a daemon for, the user's real
 * $TMPDIR/bun-spawn-cleanup. Point the whole run at a scratch directory (suites that need
 * their own pass BUN_SPAWN_CLEANUP_DIR explicitly) and stop its daemon after the last file.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIR_ENV } from "../src/platform/darwin/ledger.ts";
import { disposeRunDir, stopDaemon } from "./darwin-helpers.ts";

if (process.platform === "darwin" && !process.env[DIR_ENV]) {
  const dir = mkdtempSync(join(tmpdir(), "bsc-run-"));
  process.env[DIR_ENV] = dir;
  // A preload's afterAll runs once, after every test file (`process.on("exit")` does not
  // fire in the test runner).
  afterAll(() => {
    disposeRunDir();
    stopDaemon(dir);
    rmSync(dir, { recursive: true, force: true });
  });
}
