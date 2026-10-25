/**
 * Shared plumbing for the process-tree tests.
 *
 * Tree under test:   bun test -> owner.ts (uses the library) -> child.ts -> [launcher] -> leaf.ts
 *
 * The test never talks to the leaf directly; it learns the leaf pid from the owner's output
 * (the leaf writes a pidfile that child.ts watches) and then checks liveness with kernel32.
 *
 * The test runner itself must never call the library's `spawn`: that would
 * put the whole `bun test` process in a job for the rest of the run and make every later
 * result order-dependent. Only fixtures (separate processes) use the library.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISABLE_ENV } from "../src/backend.ts";
import { isPidAlive } from "../src/platform/windows/ffi.ts";

export const IS_WINDOWS = process.platform === "win32";
export const sleep = (ms: number) => Bun.sleep(ms);

/** Decode a byte stream into complete lines, carrying partial lines across chunks. */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
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
  buf += decoder.decode();
  if (buf) yield buf;
}

const OWNER = join(import.meta.dir, "fixtures", "owner.ts");
const tempDirs: string[] = [];

export function tempPidfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "bsc-"));
  tempDirs.push(dir);
  return join(dir, "leaf.pid");
}

export function cleanupTempDirs(): void {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export interface OwnerRun {
  proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  ownerPid: number;
  childPid: number;
  childContained: boolean | undefined;
  status: { active: boolean; guarantee: string; reason?: string };
  lines: string[];
  /** Resolve the next line matching `re` (or an already-seen one). */
  waitFor(re: RegExp, timeoutMs?: number): Promise<RegExpExecArray>;
  send(cmd: string): void;
}

export interface OwnerOptions {
  scenario: string;
  pidfile: string;
  childMode?: "stay" | "exit";
  /** Set BUN_SPAWN_CLEANUP_DISABLE=1 in the owner: the control case. */
  disable?: boolean;
  /** Extra env for the owner, e.g. to pin a platform mechanism (Linux best-effort suite). */
  env?: Record<string, string>;
  /**
   * POSIX only. Start the owner as a background job of a shell that then `exec`s `sleep`, so
   * the owner's parent never waits for it: when the owner dies it stays a zombie. The
   * owner's stdin is /dev/null in this mode, so `send()` is not available. `proc` is the
   * sleep; kill it when done.
   */
  zombieParent?: boolean;
  /**
   * Spawn the owner detached from the test runner, so it is NOT inside Bun's default job for
   * runner children. Needed by the breakaway control, where an outer no-breakaway job would
   * refuse CREATE_BREAKAWAY_FROM_JOB regardless of what the owner's own job allows.
   */
  detached?: boolean;
  /**
   * Command prefix that ends by exec'ing the owner, e.g. `["sh", "-c", 'trap "" HUP; exec "$@"', "sh"]`
   * to start it with an inherited ignored signal. The owner keeps the spawned pid.
   */
  wrap?: string[];
}

export const ownersStarted = new Set<number>();
export const leavesSeen = new Set<number>();

/** Record a pid for afterEach cleanup as soon as it is known. */
export function trackLeaf(pid: number): void {
  if (pid > 0) leavesSeen.add(pid);
}

export async function startOwner(opts: OwnerOptions): Promise<OwnerRun> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  if (opts.disable) env[DISABLE_ENV] = "1";
  else delete env[DISABLE_ENV];
  Object.assign(env, opts.env);

  const cmd = [...(opts.wrap ?? []), process.execPath, OWNER, opts.scenario, opts.pidfile, opts.childMode ?? "stay"];
  const proc = Bun.spawn(opts.zombieParent ? ["sh", "-c", '"$0" "$1" "$2" "$3" "$4" & exec sleep 1000', ...cmd] : cmd, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env,
    detached: opts.detached ?? false,
  });
  ownersStarted.add(proc.pid);

  const lines: string[] = [];
  const waiters: Array<{ re: RegExp; resolve: (m: RegExpExecArray) => void }> = [];
  (async () => {
    for await (const line of readLines(proc.stdout)) {
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        const m = waiters[i]!.re.exec(line);
        if (m) {
          waiters[i]!.resolve(m);
          waiters.splice(i, 1);
        }
      }
    }
  })();

  const waitFor = (re: RegExp, timeoutMs = 20_000): Promise<RegExpExecArray> => {
    for (const l of lines) {
      const m = re.exec(l);
      if (m) return Promise.resolve(m);
    }
    return new Promise((resolve, reject) => {
      const w = { re, resolve };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) {
          waiters.splice(i, 1);
          reject(new Error(`timeout waiting for ${re} ; owner output so far:\n${lines.join("\n")}`));
        }
      }, timeoutMs);
    });
  };

  const status = JSON.parse((await waitFor(/^STATUS (.*)$/))[1]!);
  const ownerPid = Number((await waitFor(/^OWNER (\d+)$/))[1]);
  const c = await waitFor(/^CHILD (\d+) contained=(\w+)$/);
  const childContained = c[2] === "true" ? true : c[2] === "false" ? false : undefined;
  trackLeaf(Number(c[1])); // child.ts outlives a disabled owner; make sure afterEach reaps it

  return {
    proc,
    ownerPid,
    childPid: Number(c[1]),
    childContained,
    status,
    lines,
    waitFor,
    send: (cmd) => {
      proc.stdin.write(cmd + "\n");
      proc.stdin.flush();
    },
  };
}

/** Wait for the owner to report the leaf, and record it for afterEach cleanup. */
export async function waitForLeaf(run: OwnerRun): Promise<{ pid: number; contained: boolean | undefined }> {
  const m = await run.waitFor(/^LEAF (\d+) contained=(\w+)$/, 30_000);
  const pid = Number(m[1]);
  trackLeaf(pid);
  return { pid, contained: m[2] === "true" ? true : m[2] === "false" ? false : undefined };
}

/**
 * Hard-kill ONE pid with no tree walk and no chance for cleanup code to run:
 * Windows `taskkill /F /PID` (deliberately without /T), POSIX SIGKILL.
 */
export async function hardKill(pid: number): Promise<void> {
  if (IS_WINDOWS) {
    const p = Bun.spawn(["taskkill", "/F", "/PID", String(pid)], { stdout: "ignore", stderr: "ignore" });
    await p.exited;
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Is the pid alive? Windows: kernel32 GetExitCodeProcess. POSIX: kill(pid, 0). */
export function pidAlive(pid: number): boolean {
  if (IS_WINDOWS) return isPidAlive(pid) === true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not ours
  }
}

/** True if the pid is still alive after `ms` of polling. */
export async function aliveAfter(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return false;
    await sleep(100);
  }
  return pidAlive(pid);
}

/** Executable name for a pid (tasklist / ps), or undefined if it is gone. Guards against pid reuse. */
async function imageName(pid: number): Promise<string | undefined> {
  if (IS_WINDOWS) {
    const p = Bun.spawn(["tasklist", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const out = await p.stdout.text();
    await p.exited;
    const m = /^"([^"]+)"/.exec(out.trim());
    return m?.[1];
  }
  const p = Bun.spawn(["ps", "-p", String(pid), "-o", "comm="], { stdout: "pipe", stderr: "ignore" });
  const out = (await p.stdout.text()).trim();
  await p.exited;
  return out ? out.split("/").pop() : undefined;
}

/**
 * Kill every process this test file started, so a failing test never leaks a bun leaf.
 * Every fixture process is bun; a pid that now belongs to something else is skipped, so a
 * reused pid can never make us kill an unrelated process.
 */
export async function reapAll(): Promise<void> {
  for (const pid of [...leavesSeen, ...ownersStarted]) {
    if (!pidAlive(pid)) continue;
    const name = (await imageName(pid))?.toLowerCase();
    if (name === "bun.exe" || name === "bun") await hardKill(pid);
  }
  leavesSeen.clear();
  ownersStarted.clear();
  cleanupTempDirs();
}
