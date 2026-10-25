#!/usr/bin/env bun
/**
 * bun-spawn-cleanup <command>
 *
 *   daemon [--once]   run the macOS cleanup daemon in the foreground (one per ledger
 *                     directory; exits 0 at once if another holds the lock). --once: sweep
 *                     stale ledgers and exit.
 *   sweep             kill the trees of every ledger whose owner is gone; print what died
 *   status            ledger directory, live owners, whether a daemon is serving
 *   ls                every process carrying a BUN_SPAWN_CLEANUP_ID marker, grouped by owner
 *
 * macOS: ledger based, honors BUN_SPAWN_CLEANUP_DIR.
 *
 * Linux: `sweep`, `status` and `ls` read the cgroup2 mount (every `bsc-<pid>-<hex>` owner
 * cgroup, wherever it lives; `cgroup.procs` lists every survivor exactly) plus, for
 * best-effort owners, processes carrying a BUN_SPAWN_CLEANUP_ID marker. `daemon` is not
 * needed there (each owner has its own supervisor). Windows (Job Objects) needs no helper:
 * every command prints "not needed on this platform" and exits 0.
 */
const [cmd = "help", ...rest] = process.argv.slice(2);
const usage = "usage: bun-spawn-cleanup <daemon [--once] | sweep | status | ls>";

if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(usage);
  process.exit(0);
}
if (!["daemon", "sweep", "status", "ls"].includes(cmd)) {
  console.error(usage);
  process.exit(2);
}
if (process.platform === "linux" && cmd !== "daemon") {
  await runLinux(cmd);
  process.exit(0);
}
if (process.platform !== "darwin") {
  console.log(`bun-spawn-cleanup ${cmd}: not needed on this platform (${process.platform})`);
  process.exit(0);
}

const { runDaemon } = await import("../src/platform/darwin/daemon.ts");
const ledger = await import("../src/platform/darwin/ledger.ts");
const { snapshot, markerSegments } = await import("../src/platform/darwin/procs.ts");
const { shortInfo } = await import("../src/platform/darwin/ffi.ts");

const dir = ledger.ledgerDir();
const now = () => new Date().toISOString();

switch (cmd) {
  case "daemon": {
    const once = rest.includes("--once");
    process.exit(runDaemon({ dir, once, log: (l) => console.error(`${now()} bsc-daemon: ${l}`) }));
  }
  case "sweep": {
    ledger.ensureDir(dir);
    const swept = ledger.sweepStale(dir);
    for (const r of swept) console.log(`swept owner ${r.owner}: killed ${r.killed.length} process(es)${r.killed.length ? ` (${r.killed.join(" ")})` : ""}`);
    if (!swept.length) console.log("nothing to sweep");
    process.exit(0);
  }
  case "status": {
    console.log(`ledger dir: ${dir}`);
    const d = ledger.liveDaemon(dir);
    console.log(d ? `daemon: running (pid ${d.pid}, since ${new Date(d.started).toISOString()})` : "daemon: not running");
    for (const name of ledger.listLedgers(dir)) {
      const l = ledger.readLedger(`${dir}/${name}`);
      if (!l) continue;
      const alive = ledger.sameProcessAlive(l.owner.pid, l.owner.uid);
      console.log(`owner ${l.marker}: pid ${l.owner.pid} ${alive ? "alive" : "GONE (stale, will be swept)"}, ${l.spawns.length} spawn(s), ${l.lineage.length} known descendant id(s)`);
    }
    process.exit(0);
  }
  case "ls": {
    const groups = new Map<string, string[]>();
    for (const r of snapshot()) {
      const segs = markerSegments(r.pid);
      if (!segs?.length) continue;
      // Group by the outermost owner key (`<pid>-<uid>`, the segment minus its `-<seq>`).
      const owner = segs[0]!.replace(/-\d+$/, "");
      const line = `  ${r.pid} ${shortInfo(r.pid)?.comm ?? "?"} ${segs.join(":")}`;
      groups.set(owner, [...(groups.get(owner) ?? []), line]);
    }
    if (!groups.size) console.log("no marked processes");
    for (const [owner, lines] of groups) console.log(`owner ${owner}:\n${lines.join("\n")}`);
    process.exit(0);
  }
}

/** The Linux commands. Owner cgroups first (cgroup mode), then marker carriers (best-effort mode). */
async function runLinux(command: string): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { cgroup2Root } = await import("../src/platform/linux/cgroup.ts");
  const sw = await import("../src/platform/linux/sweep.ts");
  const root = cgroup2Root();
  const comm = (pid: number) => {
    try {
      return readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      return "?";
    }
  };
  const owners = () =>
    (root ? sw.findOwnerCgroups(root) : []).map((dir) => {
      const name = dir.slice(dir.lastIndexOf("/") + 1);
      const pid = sw.ownerPidOf(name)!;
      return { dir, name, pid, alive: sw.ownerAlive(dir, pid) };
    });
  /** Marker carriers grouped by outermost owner segment (`<pid>-<hex>`). */
  const markerGroups = () => {
    const groups = new Map<string, Array<{ pid: number; value: string; ownerPid: number }>>();
    for (const m of sw.markedProcesses()) {
      const key = m.value.split(":")[0]!;
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return groups;
  };
  const markerOwnerAlive = (ownerPid: number) => {
    try {
      const stat = readFileSync(`/proc/${ownerPid}/stat`, "latin1");
      const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
      return state !== "Z" && state !== "X";
    } catch {
      return false;
    }
  };

  switch (command) {
    case "sweep": {
      let any = false;
      for (const r of root ? sw.sweepAllDeadOwners(root) : []) {
        any = true;
        const killed = r.killed.length ? ` (${r.killed.join(" ")})` : "";
        console.log(`swept owner ${r.dir.slice(r.dir.lastIndexOf("/") + 1)} (pid ${r.ownerPid}, ${r.dir}): killed ${r.killed.length} process(es)${killed}, ${r.removed ? "removed" : "NOT removed"}${r.error ? `; ${r.error}` : ""}`);
      }
      for (const [owner, pids] of sw.sweepDeadMarkers()) {
        any = true;
        console.log(`swept marker owner ${owner}: killed ${pids.length} process(es) (${pids.join(" ")})`);
      }
      if (!any) console.log("nothing to sweep");
      return;
    }
    case "status": {
      console.log(`cgroup2 root: ${root ?? "none (cgroup v1 host?)"}`);
      const list = owners();
      for (const o of list) {
        console.log(`owner ${o.name}: pid ${o.pid} ${o.alive ? "alive" : "GONE (stale, will be swept)"}, ${sw.cgroupMembers(o.dir).length} member(s), ${o.dir}`);
      }
      const groups = markerGroups();
      for (const [owner, procs] of groups) {
        const pid = procs[0]!.ownerPid;
        console.log(`marker owner ${owner}: pid ${pid} ${markerOwnerAlive(pid) ? "alive" : "GONE (stale, will be swept)"}, ${procs.length} marked process(es)`);
      }
      if (!list.length && !groups.size) console.log("no owners");
      return;
    }
    case "ls": {
      const list = owners();
      for (const o of list) {
        const members = sw.cgroupMembers(o.dir);
        console.log(`owner ${o.name} (pid ${o.pid} ${o.alive ? "alive" : "GONE"}, ${o.dir}):`);
        for (const pid of members) console.log(`  ${pid} ${comm(pid)}`);
        if (!members.length) console.log("  (empty)");
      }
      const groups = markerGroups();
      for (const [owner, procs] of groups) {
        console.log(`marker owner ${owner}:`);
        for (const m of procs) console.log(`  ${m.pid} ${comm(m.pid)} ${m.value}`);
      }
      if (!list.length && !groups.size) console.log("no owners");
      return;
    }
  }
}
