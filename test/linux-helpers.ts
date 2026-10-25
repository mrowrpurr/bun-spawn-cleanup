/**
 * Host capability probes for the Linux suites, evaluated once at load time in SEPARATE
 * processes so the test runner never joins a cgroup or starts a supervisor itself.
 */
import { join } from "node:path";

export const IS_LINUX = process.platform === "linux";

export interface HostStatus {
  backend: string;
  guarantee: string;
  active: boolean;
  reason?: string;
}

/** What the library picks on this host with no env knobs set. */
export function hostStatus(env: Record<string, string> = {}): HostStatus | undefined {
  if (!IS_LINUX) return undefined;
  const r = Bun.spawnSync([process.execPath, join(import.meta.dir, "fixtures", "status-probe.ts")], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "inherit",
  });
  try {
    return JSON.parse(r.stdout.toString().trim()) as HostStatus;
  } catch {
    return undefined;
  }
}

/** Can `systemd-run --user` start scopes/services here (user manager reachable)? */
export function systemdUserAvailable(): boolean {
  if (!IS_LINUX || !Bun.which("systemd-run")) return false;
  const r = Bun.spawnSync(["systemd-run", "--user", "--scope", "--quiet", "true"], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 5_000,
  });
  return r.exitCode === 0;
}

/** cgroup v2 directory of a pid (`/sys/fs/cgroup<path>`), for asserting cleanup. */
export function cgroupDirOf(pid: number): string | undefined {
  try {
    const line = require("node:fs")
      .readFileSync(`/proc/${pid}/cgroup`, "utf8")
      .split("\n")
      .find((l: string) => l.startsWith("0::"));
    return line ? `/sys/fs/cgroup${line.slice(3).trim()}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pid of the MAIN supervisor shell for an owner, found by its argv `bsc-supervisor <token>`.
 * Its poller subshell has the same cmdline, so pick the session leader (the supervisor is
 * spawned `detached`, i.e. `setsid`, so its sid equals its pid; the subshell's does not).
 */
export function findSupervisorPid(token: string): number | undefined {
  const fs = require("node:fs");
  for (const d of fs.readdirSync("/proc") as string[]) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv: string[] = fs.readFileSync(`/proc/${d}/cmdline`, "latin1").split("\0");
      if (!argv.includes("bsc-supervisor") || !argv.includes(token)) continue;
      const stat: string = fs.readFileSync(`/proc/${d}/stat`, "latin1");
      const sid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3]; // state ppid pgrp session
      if (sid === d) return Number(d);
    } catch {
      /* gone */
    }
  }
  return undefined;
}

/** Process state letter from /proc/<pid>/stat (R, S, T, Z, ...), or undefined. */
export function procState(pid: number): string | undefined {
  try {
    const stat = require("node:fs").readFileSync(`/proc/${pid}/stat`, "latin1") as string;
    return stat.slice(stat.lastIndexOf(")") + 2)[0];
  } catch {
    return undefined;
  }
}

/**
 * Pid of the MAIN supervisor shell of the owner with pid `ownerPid`, in either mode: its argv
 * token is `bsc-<ownerPid>-<hex>` (cgroup) or `bsc-<ownerPid>-<12 hex>` (best-effort), and it
 * is the session leader (its poller shares the cmdline but not sid == pid).
 */
export function findSupervisorPidByOwner(ownerPid: number): number | undefined {
  const fs = require("node:fs");
  const prefix = `bsc-${ownerPid}-`;
  for (const d of fs.readdirSync("/proc") as string[]) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const argv: string[] = fs.readFileSync(`/proc/${d}/cmdline`, "latin1").split("\0");
      if (!argv.includes("bsc-supervisor") || !argv.some((a) => a.startsWith(prefix))) continue;
      const stat: string = fs.readFileSync(`/proc/${d}/stat`, "latin1");
      const sid = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[3];
      if (sid === d) return Number(d);
    } catch {
      /* gone */
    }
  }
  return undefined;
}

export interface LinuxOwnerRun {
  proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  ownerPid: number;
  status: HostStatus;
  lines: string[];
  /** Resolve the first unconsumed line matching `re` (already seen or future) and CONSUME it. */
  waitFor(re: RegExp, timeoutMs?: number): Promise<RegExpExecArray>;
  send(cmd: string): void;
  /** Send `status` and return the next STATUS reply. */
  status_(): Promise<HostStatus>;
}

/** Start test/fixtures/linux-owner.ts (see its header for the protocol). */
export async function startLinuxOwner(env: Record<string, string> = {}): Promise<LinuxOwnerRun> {
  const { readLines, ownersStarted } = await import("./helpers.ts");
  const { DISABLE_ENV } = await import("../src/backend.ts");
  const fullEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete fullEnv[DISABLE_ENV];
  Object.assign(fullEnv, env);
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "linux-owner.ts")], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    env: fullEnv,
  });
  ownersStarted.add(proc.pid);
  const lines: string[] = [];
  const waiters: Array<{ re: RegExp; resolve: (line: string) => void }> = [];
  (async () => {
    for await (const line of readLines(proc.stdout)) {
      const i = waiters.findIndex((w) => w.re.test(line));
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(line);
      else lines.push(line);
    }
  })();
  const waitFor = (re: RegExp, timeoutMs = 20_000): Promise<RegExpExecArray> => {
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return Promise.resolve(re.exec(lines.splice(i, 1)[0]!)!);
    return new Promise((resolve, reject) => {
      const w = { re, resolve: (line: string) => resolve(re.exec(line)!) };
      waiters.push(w);
      setTimeout(() => {
        const k = waiters.indexOf(w);
        if (k >= 0) {
          waiters.splice(k, 1);
          reject(new Error(`timeout waiting for ${re}; unconsumed output:\n${lines.join("\n")}`));
        }
      }, timeoutMs);
    });
  };
  const send = (cmd: string) => {
    proc.stdin.write(cmd + "\n");
    proc.stdin.flush();
  };
  const status = JSON.parse((await waitFor(/^STATUS (.*)$/))[1]!) as HostStatus;
  const ownerPid = Number((await waitFor(/^OWNER (\d+)$/))[1]);
  return {
    proc,
    ownerPid,
    status,
    lines,
    waitFor,
    send,
    status_: async () => {
      send("status");
      return JSON.parse((await waitFor(/^STATUS (.*)$/))[1]!) as HostStatus;
    },
  };
}
