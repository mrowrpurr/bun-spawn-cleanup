/**
 * cgroup v2 plumbing for the Linux backend. Synchronous, filesystem only, no FFI.
 *
 * Vocabulary: the "root" is where cgroup2 is mounted (normally /sys/fs/cgroup); a cgroup's
 * "path" is what /proc/<pid>/cgroup reports after `0::`; its "dir" is root + path.
 */
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { cgroupPathOf } from "./proc.ts";

const DEFAULT_ROOT = "/sys/fs/cgroup";

/** Mount point of the cgroup2 filesystem, from /proc/self/mountinfo. */
export function cgroup2Root(): string | undefined {
  try {
    for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
      // 36 35 0:30 / /sys/fs/cgroup rw,... - cgroup2 cgroup2 rw,...
      const dash = line.indexOf(" - ");
      if (dash < 0) continue;
      const fstype = line.slice(dash + 3).split(" ")[0];
      if (fstype !== "cgroup2") continue;
      const fields = line.slice(0, dash).split(" ");
      const mountPoint = fields[4];
      if (mountPoint) return mountPoint.replace(/\\040/g, " ");
    }
  } catch {
    /* fall through */
  }
  return existsSync(`${DEFAULT_ROOT}/cgroup.controllers`) ? DEFAULT_ROOT : undefined;
}

export function joinCgroup(root: string, path: string): string {
  return path === "/" ? root : root + path;
}

export function readCgroupFile(dir: string, name: string): string | undefined {
  try {
    return readFileSync(`${dir}/${name}`, "utf8");
  } catch {
    return undefined;
  }
}

/** Write to a cgroup control file. Returns the error code (e.g. `EACCES`, `EBUSY`) on failure. */
export function writeCgroupFile(dir: string, name: string, value: string): string | undefined {
  try {
    writeFileSync(`${dir}/${name}`, value);
    return undefined;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? String(e);
  }
}

/** `populated 1`/`populated 0` from cgroup.events; undefined if the cgroup is gone. */
export function isPopulated(dir: string): boolean | undefined {
  const events = readCgroupFile(dir, "cgroup.events");
  if (events === undefined) return undefined;
  return /^populated 1$/m.test(events);
}

/** mkdir a child cgroup. Returns the error code on failure. */
export function makeCgroup(dir: string): string | undefined {
  try {
    mkdirSync(dir);
    return undefined;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? String(e);
  }
}

export function removeCgroup(dir: string): boolean {
  try {
    rmdirSync(dir);
    return true;
  } catch {
    return false;
  }
}

/** Move `pid` into `dir` (all its threads). Returns the error code on failure. */
export function moveToCgroup(dir: string, pid: number): string | undefined {
  return writeCgroupFile(dir, "cgroup.procs", String(pid));
}

/** SIGKILL every process in `dir` and its descendants, atomically (kernel >= 5.14). */
export function killCgroup(dir: string): string | undefined {
  return writeCgroupFile(dir, "cgroup.kill", "1");
}

/**
 * Ask the user's systemd instance to move `pid` into a fresh transient scope under its own
 * (delegated, user-owned) cgroup tree. This is what rescues a plain login session: the
 * session scope cgroup is owned by root, but everything under `user@<uid>.service` is owned
 * by the user. Equivalent to `systemd-run --user --scope`, except for an already-running pid.
 *
 * `extraPids` (the caller's existing descendants, for adoption) are moved into the same scope
 * in the same call; systemd rejects the whole call if one of them is gone or not ours, so the
 * caller retries without them on failure.
 *
 * Returns the new cgroup path on success, or a reason string on failure. Never throws.
 */
export function moveSelfToTransientScope(pid: number, unitName: string, extraPids: number[] = []): { path: string } | { reason: string } {
  const busctl = Bun.which("busctl");
  if (!busctl) return { reason: "busctl not found" };
  if (!process.env.DBUS_SESSION_BUS_ADDRESS && !process.env.XDG_RUNTIME_DIR) {
    return { reason: "no user D-Bus session (DBUS_SESSION_BUS_ADDRESS / XDG_RUNTIME_DIR unset)" };
  }
  const before = cgroupPathOf("self");
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(
      [
        busctl,
        "--user",
        "call",
        "org.freedesktop.systemd1",
        "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager",
        "StartTransientUnit",
        "ssa(sv)a(sa(sv))",
        unitName,
        "fail",
        "2",
        "PIDs",
        "au",
        String(1 + extraPids.length),
        String(pid),
        ...extraPids.map(String),
        "Delegate",
        "b",
        "true",
        "0",
      ],
      { stdout: "ignore", stderr: "pipe", timeout: 5_000 },
    );
  } catch (e) {
    return { reason: `busctl spawn failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (r.exitCode !== 0) {
    const err = r.stderr?.toString().trim().split("\n")[0] ?? "";
    return { reason: `StartTransientUnit failed (exit ${r.exitCode}${err ? `: ${err}` : ""})` };
  }
  // The job is queued; the migration lands a few milliseconds later. Wait for it.
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const now = cgroupPathOf("self");
    if (now && now !== before && now.endsWith(`/${unitName}`)) return { path: now };
    Bun.sleepSync(5);
  }
  return { reason: "StartTransientUnit succeeded but /proc/self/cgroup never changed" };
}
