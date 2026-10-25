/**
 * macOS escape scenarios. See test/darwin-*.test.ts for which are expected to be contained
 * (and by which tag) and which are asserted as escapes.
 *
 * Each one launches `${bun} ${leaf} ${pidfile}` through a different route. Shell-based ones
 * pass the paths as positional parameters (`"$0" "$1" "$2"`) so no quoting is ever needed.
 * macOS ships no `setsid` binary; perl (present on every macOS so far) provides one.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ledgerDir, liveDaemon } from "../../../src/platform/darwin/ledger.ts";
import type { ScenarioMap } from "./types.ts";

const quiet = () => ({ stdio: ["ignore", "ignore", "ignore"] as ["ignore", "ignore", "ignore"] });
const SETSID_EXEC = "use POSIX; setsid() or die qq(setsid: $!); exec @ARGV or die qq(exec: $!)";

/**
 * Label for the launchctl scenario: `bsc-test.<run dir>.<pidfile dir>`, derived from the
 * pidfile path so the test (and its cleanup, scoped to its own run dir) can remove it.
 */
export const launchctlLabel = (pidfile: string) => `bsc-test.${basename(dirname(dirname(pidfile)))}.${basename(dirname(pidfile))}`;

export const darwin: ScenarioMap = {
  // New session and process group (macOS has no setsid(1); perl's POSIX::setsid). Escapes any
  // process-group kill; carries the marker; direct child of child.ts, so lineage has it too.
  async setsid({ bun, leaf, pidfile }) {
    Bun.spawn(["perl", "-e", SETSID_EXEC, bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // `nohup ... &` from a shell that exits at once: orphaned and reparented to launchd before
  // anyone looks. The marker catches it; lineage only if a scan saw the shell alive.
  async "nohup-bg"({ bun, leaf, pidfile }) {
    Bun.spawn(["sh", "-c", 'nohup "$0" "$1" "$2" >/dev/null 2>&1 &', bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // Classic daemonize through two shells, both of which exit at once.
  async "double-fork"({ bun, leaf, pidfile }) {
    Bun.spawn(["sh", "-c", '( "$0" "$1" "$2" </dev/null >/dev/null 2>&1 & ) &', bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // Row E of the proposal: env scrubbed AND setsid. No marker, no group; the leaf is created
  // by child.ts, which the owner recorded at spawn, so lineage catches it.
  async "env-strip"({ bun, leaf, pidfile }) {
    Bun.spawn(["env", "-i", "perl", "-e", SETSID_EXEC, bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // Row F: a daemonizer whose intermediate forks the real daemon and exits within
  // microseconds, the daemon having setsid'd and scrubbed its env. Lineage needs the
  // intermediate's unique id and nothing ever sees it alive; the marker is gone. ESCAPE.
  async "fast-double-fork-env-strip"({ bun, leaf, pidfile }) {
    const script =
      "use POSIX; my $p = fork; die qq(fork: $!) unless defined $p;" +
      "if ($p == 0) { setsid(); if (fork == 0) { exec @ARGV; POSIX::_exit(127) } POSIX::_exit(0) }" +
      "waitpid($p, 0); exit 0";
    Bun.spawn(["perl", "-e", script, "env", "-i", bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // Row B: a Bun child (inherits NO_ORPHANS when the owner opted in) whose child is a
  // non-Bun-like leaf (flag stripped), the ffmpeg-under-a-Bun-worker case.
  async "bun-child"({ bun, leaf, pidfile }) {
    const code =
      "const e = { ...process.env }; delete e.BUN_FEATURE_FLAG_NO_ORPHANS;" +
      "Bun.spawn(process.argv.slice(1), { env: e, stdio: ['ignore', 'ignore', 'ignore'] });" +
      "setInterval(() => {}, 60000);";
    Bun.spawn([bun, "-e", code, bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },

  // Row G: broker launch. launchd forks the leaf with launchd's env: not our descendant, no
  // marker. ESCAPE on every OS by construction. `submit` jobs are KeepAlive, so the test
  // must `launchctl remove` the label (printed here) before killing the leaf.
  async launchctl({ bun, leaf, pidfile, say }) {
    if (!Bun.which("launchctl")) {
      say("ERROR launchctl not found");
      return "no-leaf";
    }
    const label = launchctlLabel(pidfile);
    const r = Bun.spawnSync(["launchctl", "submit", "-l", label, "--", bun, leaf, pidfile], { stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) {
      say(`ERROR launchctl submit failed: ${r.stderr.toString().trim()}`);
      return "no-leaf";
    }
    say(`LAUNCHCTL ${label}`);
    return "leaf-expected";
  },

  // LaunchServices: a throwaway background-only .app (built in the test's scratch dir) whose
  // executable execs the leaf, launched with `open -n -a`. launchd forks it (ppid 1, own
  // process group), so lineage and pgid miss it, but `open` passes the caller's env through,
  // marker included (observed on macOS 27). Prints `SKIP <reason>` and launches nothing
  // countable when `open` is missing, fails, or LaunchServices never starts the app.
  async "open-a"({ bun, leaf, pidfile, say }) {
    if (!Bun.which("open")) {
      say("SKIP open not found");
      return "no-leaf";
    }
    const dir = dirname(pidfile);
    const app = join(dir, "Leaf.app");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>leaf</string>
<key>CFBundleIdentifier</key><string>dev.bsc-test.${basename(dir).replace(/[^A-Za-z0-9-]/g, "-")}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
`,
    );
    const sq = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    writeFileSync(join(app, "Contents", "MacOS", "leaf"), `#!/bin/sh\nexec ${sq(bun)} ${sq(leaf)} ${sq(pidfile)}\n`, { mode: 0o755 });
    const r = Bun.spawnSync(["open", "-n", "-a", app], { stdout: "ignore", stderr: "pipe", timeout: 15_000 });
    if (r.exitCode !== 0) {
      say(`SKIP open failed (${r.exitCode ?? "timeout"}): ${r.stderr.toString().trim()}`);
      return "no-leaf";
    }
    for (const deadline = Date.now() + 15_000; Date.now() < deadline; await Bun.sleep(50)) {
      if (await Bun.file(pidfile).exists()) return "leaf-expected";
    }
    say("SKIP open launch timed out (no pidfile after 15 s)");
    return "no-leaf";
  },

  // Any same-user descendant can kill the daemon (macOS has no signal scoping). Kill it,
  // then start an orphaned leaf the usual way.
  async "kill-daemon"({ bun, leaf, pidfile, say }) {
    const d = liveDaemon(ledgerDir());
    if (d) {
      process.kill(d.pid, "SIGKILL");
      say(`KILLED-DAEMON ${d.pid}`);
    } else say("ERROR no daemon to kill");
    Bun.spawn(["sh", "-c", 'nohup "$0" "$1" "$2" >/dev/null 2>&1 &', bun, leaf, pidfile], quiet());
    return "leaf-expected";
  },
};
