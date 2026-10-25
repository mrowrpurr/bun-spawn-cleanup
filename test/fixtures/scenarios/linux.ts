/**
 * Linux escape scenarios. See test/linux-cgroup.test.ts, test/linux-best-effort.test.ts and
 * test/linux-controls.test.ts for which are expected to be contained or to escape under
 * each mechanism.
 *
 * Each one launches `${bun} ${leaf} ${pidfile}` through a different route. Shell-based
 * ones pass the three paths as positional parameters (`"$0" "$1" "$2"`) so no quoting of
 * the paths is ever needed.
 */
import { openSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWN_CGROUP_RE } from "../../../src/platform/linux/index.ts";
import { SUPERVISOR_ARGV0 } from "../../../src/platform/linux/supervisor.ts";
import type { ScenarioMap } from "./types.ts";

const quiet = () => ({ stdio: ["ignore", "ignore", "ignore"] as ["ignore", "ignore", "ignore"] });

export const linux: ScenarioMap = {
  // util-linux `setsid`: new session and process group. Escapes any process-group kill.
  async setsid({ bun, leaf, pidfile, say }) {
    const setsid = Bun.which("setsid");
    if (!setsid) {
      say("ERROR setsid not found");
      return "no-leaf";
    }
    Bun.spawn([setsid, bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // `nohup ... &` from a shell that exits at once: the leaf is orphaned and reparented
  // before anyone looks at it.
  async "nohup-bg"({ bun, leaf, pidfile }) {
    Bun.spawn(["sh", "-c", 'nohup "$0" "$1" "$2" >/dev/null 2>&1 &', bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // Classic daemonize: fork, child forks again and exits, grandchild lives on with no
  // ancestor left below init.
  async "double-fork"({ bun, leaf, pidfile }) {
    Bun.spawn(["sh", "-c", '( "$0" "$1" "$2" </dev/null >/dev/null 2>&1 & ) &', bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // bash `& disown`: removed from the shell's job table so SIGHUP is never forwarded.
  async disown({ bun, leaf, pidfile, say }) {
    const bash = Bun.which("bash");
    if (!bash) {
      say("ERROR bash not found");
      return "no-leaf";
    }
    Bun.spawn([bash, "-c", '"$0" "$1" "$2" >/dev/null 2>&1 & disown', bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // `env -i`: scrubs the environment, so an inherited env marker is gone. Contained by
  // cgroups (membership is not an env var) and by the best-effort subreaper walk (parent
  // links are not env vars either); only the marker net alone would miss it.
  async "env-strip"({ bun, leaf, pidfile, say }) {
    const env = Bun.which("env");
    if (!env) {
      say("ERROR env not found");
      return "no-leaf";
    }
    Bun.spawn([env, "-i", bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // A same-UID process writing its own pid into an ancestor cgroup's `cgroup.procs` leaves
  // the owner's cgroup; the kernel allows it because the user owns both directories. This
  // is the known cgroup escape. Prints `CGROUP-ESCAPE <ok|error>`; the leaf is then spawned
  // from OUTSIDE the owner's cgroup. Under best-effort there is no `bsc-` cgroup and the
  // scenario degrades to a plain spawn.
  async "cgroup-escape"({ bun, leaf, pidfile, say }) {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    const path = line?.slice(3).trim() ?? "";
    const segments = path.split("/");
    const i = segments.findIndex((s) => OWN_CGROUP_RE.test(s));
    if (i < 0) {
      say("CGROUP-ESCAPE no-bsc-cgroup");
    } else {
      const target = `/sys/fs/cgroup${segments.slice(0, i).join("/") || "/"}`;
      try {
        writeFileSync(`${target}/cgroup.procs`, String(process.pid));
        say("CGROUP-ESCAPE ok");
      } catch (e) {
        say(`CGROUP-ESCAPE error ${(e as NodeJS.ErrnoException).code ?? e}`);
      }
    }
    Bun.spawn([bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // A descendant trying to kill the supervisor (found by its argv[0] and the owner's
  // cgroup token). The supervisor is a session leader with a background poller in its
  // process group, so the attempt targets the whole group. With Landlock signal scoping
  // (kernel 6.12+) the kernel refuses with EPERM. Prints `KILL-SUPERVISOR <ok|error
  // CODE|not-found>`, then spawns the leaf normally.
  async "kill-supervisor"({ bun, leaf, pidfile, say }) {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((l) => l.startsWith("0::"));
    const segments = (line?.slice(3).trim() ?? "").split("/");
    const i = segments.findIndex((s) => OWN_CGROUP_RE.test(s));
    const token = i < 0 ? "" : segments[i]!; // bsc-<ownerpid>-<hex>, also the supervisor's argv token
    let found: number | undefined;
    for (const d of readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const argv = readFileSync(`/proc/${d}/cmdline`, "latin1").split("\0");
        if (argv.includes(SUPERVISOR_ARGV0) && token && argv.includes(token)) {
          found = Number(d);
          break;
        }
      } catch {
        /* gone */
      }
    }
    if (found === undefined) say("KILL-SUPERVISOR not-found");
    else {
      try {
        process.kill(-found, "SIGKILL"); // negative pid: the supervisor's process group
        say("KILL-SUPERVISOR ok");
      } catch (e) {
        say(`KILL-SUPERVISOR error ${(e as NodeJS.ErrnoException).code ?? e}`);
      }
    }
    Bun.spawn([bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // A descendant trying to grab its own write end of the supervisor's trigger pipe by
  // opening /proc/<owner>/fd/<n> for every socket/pipe fd the owner holds. If one succeeded
  // and was held open, EOF would never reach the supervisor. Prints `REOPEN <n> attempts:
  // <codes>` (expected: every attempt fails, ENXIO for sockets), then spawns the leaf. Any
  // fd it did manage to open is deliberately kept open so the supervisor's liveness poller
  // is what gets tested if the kernel ever allowed this.
  async "reopen-pipe"({ bun, leaf, pidfile, say }) {
    const owner = process.ppid;
    const results: string[] = [];
    for (const fd of readdirSync(`/proc/${owner}/fd`)) {
      // 0-2 are the owner's inherited stdio, not the library's: when the test runner itself
      // has a piped stderr (CI, `| tee`), that pipe is openable here and says nothing about
      // the trigger pipe.
      if (Number(fd) <= 2) continue;
      let link = "";
      try {
        link = readlinkSync(`/proc/${owner}/fd/${fd}`);
      } catch {
        continue;
      }
      if (!/^(socket|pipe):/.test(link)) continue;
      try {
        openSync(`/proc/${owner}/fd/${fd}`, "w");
        results.push(`${fd}:${link}:OPENED`);
      } catch (e) {
        results.push(`${fd}:${(e as NodeJS.ErrnoException).code}`);
      }
    }
    say(`REOPEN ${results.length} attempts: ${results.join(" ")}`);
    Bun.spawn([bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // A nested owner: a descendant that ALSO uses this library. It must not create a cgroup of
  // its own (Landlock forbids it anyway) and above all must not move itself out of the
  // outer owner's cgroup via the transient-scope route. Prints `NESTED <status json>`.
  async "nested-owner"({ bun, leaf, pidfile, say }) {
    const lib = join(dirname(leaf), "..", "..", "src", "index.ts");
    const script = `
      import { status as cleanupStatus, spawn } from ${JSON.stringify(lib)};
      spawn([${JSON.stringify(bun)}, ${JSON.stringify(leaf)}, ${JSON.stringify(pidfile)}], { stdio: ["ignore", "ignore", "ignore"] });
      console.log("NESTED " + JSON.stringify(cleanupStatus()));
      setInterval(() => {}, 60_000);
    `;
    const p = Bun.spawn([bun, "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const reader = p.stdout.getReader();
    const { value } = await reader.read();
    say(new TextDecoder().decode(value).trim());
    return "leaf-expected";
  },

  // `systemd-run --user --scope`: the user's systemd instance creates a NEW cgroup (scope)
  // and systemd-run then runs the command there, as its own child. Env is inherited (the
  // best-effort marker survives) but cgroup membership is not: a cgroup escape.
  async "systemd-run-scope"({ bun, leaf, pidfile, say }) {
    const sr = Bun.which("systemd-run");
    if (!sr) {
      say("ERROR systemd-run not found");
      return "no-leaf";
    }
    Bun.spawn([sr, "--user", "--scope", "--quiet", bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // `systemd-run --user` (transient service): the user manager forks the command itself,
  // like WMI on Windows. Neither cgroup nor env is inherited: escapes everything.
  async "systemd-run-service"({ bun, leaf, pidfile, say }) {
    const sr = Bun.which("systemd-run");
    if (!sr) {
      say("ERROR systemd-run not found");
      return "no-leaf";
    }
    const p = Bun.spawn([sr, "--user", "--quiet", "--collect", bun, leaf, pidfile], quiet());
    await p.exited;
    return "leaf-expected";
  },
};
