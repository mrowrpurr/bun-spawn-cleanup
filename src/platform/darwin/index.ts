/**
 * macOS backend: `darwin-best-effort`, always guarantee `best-effort`.
 *
 * macOS has no unprivileged kernel containment (no Job Objects, no cgroups; coalitions need a
 * private entitlement) and no way to stop a same-user descendant from leaving or killing
 * anything, so this backend tags every process and makes sure SOMEONE acts on the tags when
 * the owner dies. See notes/2026/10/18/darwin/macos-proposal.md for the design and
 * notes/2026/10/18/darwin/darwin-backend.md for the probes and deviations.
 *
 * Tags (procs.ts): kernel lineage (`p_uniqueid` / `p_puniqueid`, survives setsid, env -i
 * and reparenting), the inherited env marker BUN_SPAWN_CLEANUP_ID=<owner key>-<seq>
 * (survives the exit of intermediates), and the process group of spawns the caller made
 * `detached`. The owner keeps its lineage set current on an unref'd timer and records
 * everything in a ledger file (ledger.ts).
 *
 * Triggers:
 *   - the owner itself: `process.on("exit")` (clean exit, process.exit, uncaught throw,
 *     unhandled rejection) and SIGINT/SIGTERM/SIGHUP/SIGQUIT (kill, then re-raise with the
 *     default disposition so the exit status is unchanged; skipped when the app has its own
 *     listener for that signal, because then the app decides whether it dies; never
 *     installed for a signal inherited as ignored, e.g. SIGHUP under nohup). Immediate.
 *     A Worker-thread owner hooks only its own exit; what a terminated Worker spawned dies
 *     with the process.
 *   - the daemon (daemon.ts), auto-started by default: kqueue NOTE_EXIT on every owner, so
 *     SIGKILL / jetsam / native crashes are cleaned up immediately too. A start is verified
 *     (daemon.json of this boot naming a live pid) and failures back off, then give up.
 *     While it serves, the owner skips its own lineage snapshots (the daemon follows forks).
 *   - the sweep: every `ensure()` (and `bun-spawn-cleanup sweep`) kills the trees of ledgers
 *     whose owner is gone. The no-daemon answer to SIGKILL; latency is "next use".
 *
 * Deliberately NOT done, unlike the proposal (see the darwin-backend note):
 *   - forcing `detached: true` on every spawn for a per-spawn process group. That is
 *     POSIX_SPAWN_SETSID: the child loses its controlling terminal, so anything that opens
 *     /dev/tty (ssh and sudo password prompts, git credential prompts, editors) breaks and
 *     terminal job control changes. Not a drop-in. Lineage + marker cover the same rows.
 *   - BUN_FEATURE_FLAG_NO_ORPHANS=1 by default. Probed: a Bun process with that flag also
 *     SIGKILLs its own direct children when IT exits normally, so a Bun child that starts a
 *     background process and exits would lose it while the owner is still alive. Opt in with
 *     BUN_SPAWN_CLEANUP_DARWIN_NO_ORPHANS=1.
 *
 * Known escapes (asserted in test/darwin-escapes.test.ts): an intermediate that forks and
 * exits before any scan or NOTE_FORK sees it, combined with `env -i` (lineage chain broken,
 * marker gone); brokers that launch on a descendant's behalf (`launchctl`, `open`, ssh, cron,
 * XPC services), whose processes are launchd's children and carry launchd's env. Any
 * same-user process can also kill the daemon; the owner restarts it on its next timer tick.
 *
 * Knobs, each an option of `configureSpawnCleanup({ darwin: {...} })` or its env var, resolved
 * ONCE in `ensure()` (option wins over env, env over default; see resolveDarwinConfig):
 * `disable` / BUN_SPAWN_CLEANUP_DISABLE=1 turns it off; `daemon` /
 * BUN_SPAWN_CLEANUP_DARWIN_DAEMON=auto (default) | off; `ledgerDir` / BUN_SPAWN_CLEANUP_DIR
 * overrides the ledger directory; `lineageMs` / BUN_SPAWN_CLEANUP_DARWIN_LINEAGE_MS (default
 * 250: the base tick, which backs off to 2 s while nothing changes; 0 disables the timer);
 * `noOrphans` / BUN_SPAWN_CLEANUP_DARWIN_NO_ORPHANS=1 also sets Bun's NO_ORPHANS flag on
 * every spawn.
 *
 * Setup ADOPTS the main thread's existing descendants (spawned by any API before
 * `configureSpawnCleanup()`): one walk by current parent from our pid plus a lineage walk
 * by creator id, every live member recorded under seq 0 (the owner itself) and persisted,
 * so the owner hooks, the daemon and the sweep all cover them. `killTree()` with no argument
 * (`killAll`) kills every descendant and leaves the owner and the backend running.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, threadId } from "node:worker_threads";
import { constants } from "node:os";
import { disabledBy, DISABLE_ENV, envFlag, type CleanupBackend, type CleanupOptions, type CleanupStatus, type SpawnedProcess } from "../../backend.ts";
import { DAEMON_ARGV0 } from "./daemon.ts";
import { bootSessionId, childPids, libSystemLoadError, loadLibSystem, shortInfo, signalIgnored, uniqueIds, IS_DARWIN } from "./ffi.ts";
import {
  daemonBarrier,
  DIR_ENV,
  ensureDir,
  ledgerDir,
  ledgerPath,
  liveDaemon,
  ownerKey,
  probeDaemonLock,
  readDaemonInfo,
  removeQuietly,
  sweepStale,
  threadLedgers,
  trustedGroups,
  writeLedger,
  type Ledger,
} from "./ledger.ts";
import { growLineage, killTagged, MARKER_ENV, markerSegments, snapshot, type Tags } from "./procs.ts";

export { MARKER_ENV } from "./procs.ts";
export const BACKEND_NAME = "darwin-best-effort";
/** `auto` (default): start the daemon when none holds the lock. `off`: never. */
export const DAEMON_ENV = "BUN_SPAWN_CLEANUP_DARWIN_DAEMON";
/** Owner-side lineage snapshot interval in ms; default 250, `0` disables. */
export const LINEAGE_MS_ENV = "BUN_SPAWN_CLEANUP_DARWIN_LINEAGE_MS";
/** `1`: also set Bun's own NO_ORPHANS flag on every spawn (see header for the trade-off). */
export const NO_ORPHANS_ENV = "BUN_SPAWN_CLEANUP_DARWIN_NO_ORPHANS";
export const BUN_NO_ORPHANS = "BUN_FEATURE_FLAG_NO_ORPHANS";
/** An auto-started daemon exits after this long with no live ledgers. */
export const DAEMON_IDLE_EXIT_MS = 60_000;
/** Test hook: override DAEMON_IDLE_EXIT_MS (ms) for daemons this owner starts. */
export const TEST_IDLE_ENV = "BSC_TEST_DAEMON_IDLE_MS";
/** Daemon off: a full listing replaces the cheap child walk at least this often. */
const FULL_SCAN_MS = 2000;
/** The adaptive timer backs off (doubling) to at most this when ticks find nothing new. */
const MAX_TICK_MS = 2000;
/** How long a freshly started daemon has to show up in daemon.json. */
const DAEMON_CONFIRM_MS = 1000;
/** Retry delays after failed starts: 2 s, 4 s, ... capped; give up after this many. */
const DAEMON_BACKOFF_CAP_MS = 60_000;
const DAEMON_MAX_FAILURES = 5;
/** While a daemon serves, the owner only re-checks it this often (no lineage scans). */
const DAEMON_CHECK_MS = 2000;
/** Spawn records of exited children kept for killTree (oldest dropped first). */
const MAX_EXITED_RECORDS = 256;

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const;

const DEFAULT_LINEAGE_MS = 250;

/** Where a resolved knob came from, for status text. */
export type KnobSource = "option" | "env" | "default";

/** Every darwin knob, resolved once at setup. */
export interface DarwinConfig {
  daemon: "auto" | "off";
  daemonFrom: KnobSource;
  dir: string;
  dirFrom: KnobSource;
  lineageMs: number;
  lineageFrom: KnobSource;
  noOrphans: boolean;
  noOrphansFrom: KnobSource;
  /** Problems worth a status note (an invalid value that fell back to the default). */
  warnings: string[];
}

/**
 * Resolve the darwin knobs: `options.darwin.<x>` ?? env ?? default. Pure apart from reading
 * `process.env`; `ensure()` calls it exactly once. Empty env values count as unset.
 */
export function resolveDarwinConfig(options?: CleanupOptions): DarwinConfig {
  const o = options?.darwin;
  const warnings: string[] = [];
  const envOf = (name: string): string | undefined => {
    const v = process.env[name];
    return v === undefined || v.trim() === "" ? undefined : v;
  };

  let daemon: "auto" | "off" = "auto";
  let daemonFrom: KnobSource = "default";
  const daemonEnv = envOf(DAEMON_ENV);
  if (o?.daemon !== undefined) {
    daemonFrom = "option";
    daemon = String(o.daemon).trim().toLowerCase() === "off" ? "off" : "auto";
  } else if (daemonEnv !== undefined) {
    daemonFrom = "env";
    daemon = daemonEnv.trim().toLowerCase() === "off" ? "off" : "auto";
  }

  const dirOption = o?.ledgerDir || undefined;
  const dirFrom: KnobSource = dirOption ? "option" : envOf(DIR_ENV) !== undefined ? "env" : "default";
  const dir = ledgerDir(dirOption);

  let lineageMs = DEFAULT_LINEAGE_MS;
  let lineageFrom: KnobSource = "default";
  const rawMs: unknown = o?.lineageMs ?? envOf(LINEAGE_MS_ENV);
  if (rawMs !== undefined) {
    const label = o?.lineageMs !== undefined ? "darwin.lineageMs option" : LINEAGE_MS_ENV;
    const n = Number(rawMs);
    if (Number.isFinite(n) && n >= 0) {
      lineageMs = n;
      lineageFrom = o?.lineageMs !== undefined ? "option" : "env";
    } else {
      warnings.push(`ignored invalid ${label} ${JSON.stringify(String(rawMs))}, using ${DEFAULT_LINEAGE_MS} ms`);
    }
  }

  const envNoOrphans = envFlag(NO_ORPHANS_ENV);
  const noOrphans = o?.noOrphans ?? envNoOrphans ?? false;
  const noOrphansFrom: KnobSource = o?.noOrphans !== undefined ? "option" : envNoOrphans !== undefined ? "env" : "default";

  return { daemon, daemonFrom, dir, dirFrom, lineageMs, lineageFrom, noOrphans, noOrphansFrom, warnings };
}

/** How a knob reads in status text: the form that applied first, then the other form. */
function knobText(option: string, env: string, optionValue: string, envValue: string, from: KnobSource): string {
  return from === "option" ? `option darwin.${option}: ${optionValue}, env ${env}` : `${env}=${envValue}, option darwin.${option}`;
}

interface SpawnRecord {
  pid: number;
  uid?: bigint;
  seq: number;
  pgid?: number;
  exited: boolean;
}

/**
 * Start the daemon detached, as `bsc-daemon -` with its script on stdin (see daemon.ts for
 * the argv hygiene), from a clean env: no marker (it must never match a scan) and no
 * NO_ORPHANS (it must outlive us). Returns its pid, or a reason.
 */
export function startDaemon(dir: string): { pid: number; proc: Bun.Subprocess } | { reason: string } {
  // In a `bun build --compile` binary or a bundle there is no daemon.ts on disk (and
  // execPath may be the app itself): never start anything we cannot vouch for.
  const mod = join(import.meta.dir, "daemon.ts");
  if (!existsSync(mod)) return { reason: `${mod} is not on disk (compiled or bundled app); run \`bun-spawn-cleanup daemon\` yourself` };
  try {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    // If execPath is a compiled app rather than bun, this makes it behave as bun.
    env.BUN_BE_BUN = "1";
    delete env[MARKER_ENV];
    delete env[BUN_NO_ORPHANS];
    delete env[DISABLE_ENV];
    // runDaemon gets `dir` as an argument; the env copy keeps the daemon's environment accurate
    // when an option overrode BUN_SPAWN_CLEANUP_DIR (anything reading it, and `ps eww`, see
    // the directory it actually serves).
    env[DIR_ENV] = dir;
    const proc = Bun.spawn([process.execPath, "-"], {
      argv0: DAEMON_ARGV0,
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
      cwd: "/",
      env,
    });
    const idle = Number(process.env[TEST_IDLE_ENV]);
    const idleExitMs = Number.isFinite(idle) && idle > 0 ? idle : DAEMON_IDLE_EXIT_MS;
    proc.stdin.write(
      `import { runDaemon } from ${JSON.stringify(mod)};\n` +
        `process.exit(runDaemon({ dir: ${JSON.stringify(dir)}, idleExitMs: ${idleExitMs} }));\n`,
    );
    proc.stdin.end();
    proc.unref();
    return { pid: proc.pid, proc };
  } catch (e) {
    return { reason: e instanceof Error ? e.message : String(e) };
  }
}

export function createDarwinBackend(): CleanupBackend {
  let memo: CleanupStatus | undefined;
  let active = false;

  let dir = "";
  let key = "";
  let path = "";
  let selfUid = 0n;
  let created = 0;
  /** In a Worker the process uid is NOT a root: the thread only owns what it spawned. */
  const mainThread = isMainThread;
  /** Inherited from an outer owner, if any: our markers nest under it. Read at setup. */
  let inherited: string | undefined;
  /** Knobs, resolved once by ensure(). */
  let cfg: DarwinConfig | undefined;

  /** Known descendants: unique id -> spawn seq it descends from (0 = the owner itself). */
  const lineage = new Map<bigint, number>();
  /** Unique id -> pid of each lineage member, as last seen (for the cheap child walk). */
  const pidOf = new Map<bigint, number>();
  let lastFull = 0;
  /** Timer tick at which each lineage member was last seen alive (for pruning). */
  const lastSeen = new Map<bigint, number>();
  const spawns = new Map<number, SpawnRecord>();
  /** Daemons this owner started: never killed, never walked through. */
  const daemonUids = new Set<bigint>();
  let seq = 0;
  let pendingSeq: number | undefined;
  let tick = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Current delay of the adaptive timer (configured interval .. MAX_TICK_MS). */
  let tickDelay = 0;
  let onTick: (() => void) | undefined;
  let cleanedUp = false;

  /**
   * Daemon bookkeeping (auto mode). `serving`: a live daemon.json of this boot names a live
   * process (it is written only after the lock is taken). `pending`: we launched one and wait
   * for that. `down`: none serving, next launch at `nextLaunch` (backoff after failures).
   * `unknown`: the lock is held but no daemon.json names a live process (one is starting), or
   * the lock cannot be probed at all. `gave-up`: DAEMON_MAX_FAILURES consecutive failures.
   */
  type DaemonState =
    | { kind: "off" | "down" | "unknown" | "gave-up" }
    | { kind: "serving"; pid: number; ours: boolean }
    | { kind: "pending"; pid: number; uid?: bigint; proc: Bun.Subprocess; since: number };
  let daemon: DaemonState = { kind: "down" };
  let daemonFailures = 0;
  let lastFailure = "";
  let nextLaunch = 0;
  let lastDaemonCheck = -Infinity;

  const fail = (guarantee: "none" | "best-effort", reason: string): CleanupStatus => ({
    platform: "darwin",
    backend: BACKEND_NAME,
    guarantee,
    active: false,
    reason,
  });

  /**
   * Daemons never to kill or walk through. `full` (kill paths) also reads every ledger's
   * list of daemons its owner started; the timer uses the cheap form (daemon.json only),
   * which is enough because kill paths filter members through the full barrier anyway.
   */
  function barrier(full = false): Set<bigint> {
    const b = full ? daemonBarrier(dir) : new Set<bigint>();
    for (const u of daemonUids) b.add(u);
    const d = readDaemonInfo(dir);
    if (d && /^\d+$/.test(d.uid)) b.add(BigInt(d.uid));
    return b;
  }

  function persist(): void {
    if (cleanedUp) return;
    const ledger: Ledger = {
      version: 1,
      owner: { pid: process.pid, uid: String(selfUid) },
      marker: key,
      created,
      boot: bootSessionId() ?? "",
      spawns: [...spawns.values()].map((s) => ({ pid: s.pid, uid: s.uid === undefined ? "" : String(s.uid), seq: s.seq, ...(s.pgid ? { pgid: s.pgid } : {}) })),
      lineage: [...lineage.keys()].map(String),
      exclude: [...daemonUids].map(String),
    };
    writeLedger(path, ledger);
  }

  /**
   * One full lineage refresh over every pid (`proc_listallpids`): grow from the known set
   * by `p_puniqueid`, which also finds orphans whose parent already exited; with `prune`,
   * drop members gone for 3 ticks.
   */
  function scan(prune: boolean): boolean {
    lastFull = Date.now();
    const before = lineage.size;
    const rows = snapshot();
    const fresh = new Map(lineage);
    growLineage(fresh, rows, barrier());
    for (const [u, s] of fresh) if (!lineage.has(u)) lineage.set(u, s);
    tick++;
    const alive = new Set(rows.map((r) => r.uid));
    for (const r of rows) if (lineage.has(r.uid)) pidOf.set(r.uid, r.pid);
    let changed = lineage.size !== before;
    for (const u of lineage.keys()) {
      if (alive.has(u) || !lastSeen.has(u)) lastSeen.set(u, tick);
    }
    if (prune) {
      for (const u of [...lineage.keys()]) {
        if (u === selfUid) continue;
        if (tick - (lastSeen.get(u) ?? tick) > 2) {
          lineage.delete(u);
          lastSeen.delete(u);
          pidOf.delete(u);
          changed = true;
        }
      }
      // Records of exited children stay (killTree can still reach their orphans by marker,
      // which no scan here can see cheaply), but only the newest MAX_EXITED_RECORDS of them.
      const exited = [...spawns.values()].filter((s) => s.exited);
      for (const s of exited.slice(0, Math.max(0, exited.length - MAX_EXITED_RECORDS))) {
        spawns.delete(s.pid);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Timer tick with no daemon serving. The full listing costs ~0.3 ms of syscalls per
   * ~700 pids, which at 4 Hz is most of an idle owner's CPU, so most ticks only walk
   * `proc_listchildpids` down from each live member (our subtree only). That walk cannot
   * see a process whose parent died before we listed it (it was reparented to launchd), so
   * a full listing runs when a member seen alive last tick is gone (it may have left such
   * orphans) and every FULL_SCAN_MS regardless. With nothing to watch (no live
   * spawn record, no member but ourselves) only our own children are listed.
   */
  function tickScan(): boolean {
    const idle = lineage.size <= (mainThread ? 1 : 0) && ![...spawns.values()].some((s) => !s.exited);
    if (!idle && Date.now() - lastFull >= FULL_SCAN_MS) return scan(true);
    tick++;
    const queue: Array<[number, bigint]> = [];
    for (const u of lineage.keys()) {
      const pid = u === selfUid ? process.pid : pidOf.get(u);
      if (pid === undefined) continue;
      if (u !== selfUid && uniqueIds(pid)?.uid !== u) {
        if (lastSeen.get(u) === tick - 1) return scan(true); // newly gone: look for its orphans
        continue;
      }
      lastSeen.set(u, tick);
      queue.push([pid, u]);
    }
    let changed = false;
    let wall: Set<bigint> | undefined;
    for (let i = 0; i < queue.length; i++) {
      const [pid, u] = queue[i]!;
      for (const c of childPids(pid)) {
        const ids = uniqueIds(c);
        if (!ids || ids.puid !== u || lineage.has(ids.uid)) continue;
        wall ??= barrier();
        if (wall.has(ids.uid)) continue;
        lineage.set(ids.uid, lineage.get(u) ?? 0);
        lastSeen.set(ids.uid, tick);
        pidOf.set(ids.uid, c);
        queue.push([c, ids.uid]);
        changed = true;
      }
    }
    return changed;
  }

  function schedule(delay: number): void {
    if (!onTick) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onTick, delay);
    timer.unref();
  }

  /** Activity: go back to the configured tick interval at once. */
  function quicken(): void {
    const ms = cfg?.lineageMs ?? 0;
    if (!onTick || ms <= 0 || tickDelay <= ms) return;
    tickDelay = ms;
    schedule(ms);
  }

  function daemonFailed(why: string, now: number): void {
    daemonFailures++;
    lastFailure = why;
    if (daemonFailures >= DAEMON_MAX_FAILURES) {
      daemon = { kind: "gave-up" };
      // The one later change of a memoized status: say coverage is gone, like Linux does
      // when its supervisor dies.
      if (memo?.active) {
        memo = {
          ...memo,
          reason: `daemon failed to start ${daemonFailures} times (last: ${why}); descendants are reaped at the next use or \`bun-spawn-cleanup sweep\``,
        };
      }
      return;
    }
    daemon = { kind: "down" };
    nextLaunch = now + Math.min(2000 * 2 ** (daemonFailures - 1), DAEMON_BACKOFF_CAP_MS);
  }

  /**
   * Advance the daemon state machine. Cheap unless it is time to probe; `force` probes now.
   * Never blocks, except `launch` itself (one Bun.spawn).
   */
  function checkDaemon(force = false): void {
    if ((cfg?.daemon ?? "off") === "off") {
      daemon = { kind: "off" };
      return;
    }
    if (daemon.kind === "gave-up") return;
    const now = Date.now();
    if (daemon.kind === "pending") {
      const live = liveDaemon(dir);
      if (live) {
        daemon = { kind: "serving", pid: live.pid, ours: live.pid === daemon.pid };
        daemonFailures = 0;
      } else if (daemon.proc.exitCode !== null || daemon.proc.signalCode !== null || uniqueIds(daemon.pid)?.uid !== daemon.uid) {
        // exitCode needs the event loop (settleDaemon blocks it); a zombie or a vanished
        // pid reports no unique id, which is the synchronous signal.
        const code = daemon.proc.exitCode ?? daemon.proc.signalCode;
        daemonFailed(code === null ? "exited" : `exited ${code}`, now);
      } else if (now - daemon.since > DAEMON_CONFIRM_MS) {
        // Left running: a slow daemon that comes up later is found by the next probe.
        daemonFailed(`pid ${daemon.pid} not serving after ${DAEMON_CONFIRM_MS} ms`, now);
      }
      return;
    }
    if (!force && now - lastDaemonCheck < DAEMON_CHECK_MS) return;
    lastDaemonCheck = now;
    const live = liveDaemon(dir);
    if (live) {
      if (daemon.kind !== "serving" || daemon.pid !== live.pid) daemon = { kind: "serving", pid: live.pid, ours: false };
      return;
    }
    if (now < nextLaunch) {
      daemon = { kind: "down" };
      return;
    }
    const lock = probeDaemonLock(dir);
    if (lock !== "free") {
      daemon = { kind: "unknown" };
      return;
    }
    const r = startDaemon(dir);
    if ("reason" in r) {
      daemonFailed(r.reason, now);
      return;
    }
    const ids = uniqueIds(r.pid);
    if (ids) daemonUids.add(ids.uid);
    persist();
    daemon = { kind: "pending", pid: r.pid, uid: ids?.uid, proc: r.proc, since: now };
  }

  /** ensure() only: start or find the daemon and wait (DAEMON_CONFIRM_MS max) for it. */
  function settleDaemon(): void {
    checkDaemon(true);
    while (daemon.kind === "pending") {
      Bun.sleepSync(50);
      checkDaemon();
    }
  }

  const SWEEP_LATER = "after SIGKILL or a crash, descendants are reaped at the next use of this library or `bun-spawn-cleanup sweep`";

  function daemonReason(): string {
    switch (daemon.kind) {
      case "off":
        return `no daemon (${cfg ? knobText("daemon", DAEMON_ENV, "off", "off", cfg.daemonFrom) : `${DAEMON_ENV}=off`}): ${SWEEP_LATER}`;
      case "serving":
        return `daemon ${daemon.ours ? "started" : "running"} (pid ${daemon.pid}): owner-death cleanup is immediate, including SIGKILL`;
      case "unknown":
        return `daemon state unknown (lock held without a live daemon.json, or the lock probe failed): SIGKILL coverage not confirmed; ${SWEEP_LATER}`;
      default:
        return `daemon failed to start (${lastFailure}); retrying with backoff; until one serves, ${SWEEP_LATER}`;
    }
  }

  function ownerTags(): Tags {
    const prefix = `${key}-`;
    return {
      lineage: new Set(lineage.keys()),
      marker: (seg) => seg.startsWith(prefix),
      pgids: trustedGroups([...spawns.values()]),
      excludePids: new Set([process.pid]),
      barrier: barrier(true),
    };
  }

  /**
   * The owner is going away by a path it can see: kill the tree now, drop the ledger. The
   * main thread's lineage is process-wide, so it also covers what Worker-thread owners of
   * this process spawned (a terminated Worker runs no exit hook): their ledgers go too.
   */
  function cleanupAll(): void {
    if (cleanedUp || !active) return;
    cleanedUp = true;
    if (timer) clearTimeout(timer);
    onTick = undefined;
    try {
      killTagged(ownerTags());
    } catch {
      /* never throw from an exit path */
    }
    removeQuietly(path);
    if (mainThread) for (const name of threadLedgers(dir, ownerKey(process.pid, selfUid))) removeQuietly(join(dir, name));
  }

  /**
   * Adopt the descendants this process already had before setup (main thread only: a Worker
   * owns just what it spawns). Two walks over one listing: by CURRENT parent
   * (`proc_listchildpids` from our pid down), and by creator id (`p_puniqueid`) from
   * everything found, which also reaches orphans of intermediates still alive at the walk.
   * Daemons are a barrier (never adopted, never walked through). Every member joins the
   * lineage under seq 0, like the owner's own forks. Returns how many were adopted out of
   * how many were found; a pid found by parent whose unique id cannot be read (a zombie, or
   * it exited mid-walk) counts as found, not adopted.
   */
  function adopt(): { adopted: number; found: number } {
    if (!mainThread) return { adopted: 0, found: 0 };
    const wall = barrier(true);
    const rows = snapshot();
    const byPid = new Map(rows.map((r) => [r.pid, r.uid] as const));
    const found = new Map<number, bigint | undefined>();
    const queue = [process.pid];
    for (let i = 0; i < queue.length; i++) {
      for (const c of childPids(queue[i]!)) {
        if (c <= 0 || c === process.pid || found.has(c)) continue;
        const uid = byPid.get(c) ?? uniqueIds(c)?.uid;
        if (uid !== undefined && (wall.has(uid) || uid === selfUid)) continue;
        found.set(c, uid);
        queue.push(c);
      }
    }
    const known = new Map<bigint, number>([[selfUid, 0]]);
    for (const uid of found.values()) if (uid !== undefined) known.set(uid, 0);
    for (const r of growLineage(known, rows, wall)) if (r.uid !== selfUid && !found.has(r.pid)) found.set(r.pid, r.uid);
    let adopted = 0;
    for (const [pid, uid] of found) {
      if (uid === undefined) continue;
      if (!lineage.has(uid)) lineage.set(uid, 0);
      pidOf.set(uid, pid);
      lastSeen.set(uid, tick);
      adopted++;
    }
    return { adopted, found: found.size };
  }

  /** After a tree kill: mark spawn records whose process is gone, refresh the lineage view. */
  function refreshAfterKill(): void {
    for (const s of spawns.values()) {
      if (s.exited) continue;
      // A SIGKILLed child not yet reaped is a zombie, which reports no unique id: exited.
      if (s.uid === undefined || uniqueIds(s.pid)?.uid !== s.uid) s.exited = true;
    }
    scan(false);
  }

  function installHooks(): void {
    process.on("exit", cleanupAll);
    if (!mainThread) return;
    for (const sig of SIGNALS) {
      // Inherited SIG_IGN (nohup, a background job of a non-interactive shell) must stay:
      // a listener would make the signal fatal again. Ignored means the owner survives it,
      // so there is nothing to clean up on it either.
      if (signalIgnored(constants.signals[sig]) !== false) continue;
      const handler = () => {
        // The app listens too: it decides whether to die (its exit runs our exit hook).
        if (process.listenerCount(sig) > 1) return;
        cleanupAll();
        process.removeListener(sig, handler);
        process.kill(process.pid, sig); // default disposition again: same exit status
      };
      process.on(sig, handler);
    }
  }

  function ensure(options?: CleanupOptions): CleanupStatus {
    if (memo) return memo;
    memo = (() => {
      if (!IS_DARWIN) return fail("none", "not darwin");
      const disabled = disabledBy(options);
      if (disabled) return fail("none", disabled);
      try {
        if (!loadLibSystem()) return fail("best-effort", `cannot load libSystem: ${libSystemLoadError()}`);
        const self = uniqueIds(process.pid);
        if (!self) return fail("best-effort", "proc_pidinfo(PROC_PIDUNIQIDENTIFIERINFO) failed on our own pid");
        selfUid = self.uid;
        cfg = resolveDarwinConfig(options);
        inherited = process.env[MARKER_ENV] || undefined;
        dir = cfg.dir;
        const dirErr = ensureDir(dir);
        key = ownerKey(process.pid, selfUid) + (mainThread ? "" : `t${threadId}`);
        path = ledgerPath(dir, key);
        created = Date.now();
        if (mainThread) {
          lineage.set(selfUid, 0);
          lastSeen.set(selfUid, 0);
        }

        const notes: string[] = [...cfg.warnings];
        // Before the first persist, so the first ledger (and so the daemon and any sweep)
        // already names them.
        try {
          const a = adopt();
          if (a.found > 0) {
            notes.push(
              a.adopted === a.found
                ? `adopted ${a.adopted} pre-existing descendant(s)`
                : `adopted ${a.adopted} of ${a.found} pre-existing descendant(s) (the rest could not be read)`,
            );
          }
        } catch (e) {
          notes.push(`could not adopt pre-existing descendants (${e instanceof Error ? e.message : String(e)})`);
        }
        if (dirErr) {
          notes.push(`ledger directory ${dir} unusable (${dirErr}): no SIGKILL coverage, owner hooks only`);
        } else {
          sweepStale(dir, key);
          persist();
        }
        installHooks();
        active = true;

        if (!dirErr) settleDaemon();
        else daemon = { kind: "off" };

        // While a daemon serves it tracks forks itself (NOTE_FORK, microseconds), so the
        // owner only re-checks it every DAEMON_CHECK_MS and skips the lineage snapshot; the
        // snapshot runs only when no daemon serves.
        //
        // Adaptive: a tick that finds nothing new doubles the delay (up to MAX_TICK_MS); a
        // tick that finds something, a pending daemon start, and spawn()/track()/killTree()
        // reset it to the configured interval.
        const ms = cfg.lineageMs;
        if (ms > 0) {
          tickDelay = ms;
          onTick = () => {
            let changed = false;
            try {
              const before = daemon.kind;
              if (!dirErr) checkDaemon();
              changed = daemon.kind !== before || daemon.kind === "pending";
              if (daemon.kind !== "serving" && tickScan()) {
                persist();
                changed = true;
              }
            } catch {
              /* a failed tick is retried next tick */
            }
            tickDelay = changed ? ms : Math.min(tickDelay * 2, Math.max(ms, MAX_TICK_MS));
            schedule(tickDelay);
          };
          schedule(ms);
        }

        if (!dirErr) notes.push(daemonReason());
        if (inherited) notes.push("nested under another owner's marker");
        if (ms === 0) notes.push(`owner lineage timer off (${knobText("lineageMs", LINEAGE_MS_ENV, "0", "0", cfg.lineageFrom)})`);
        if (cfg.noOrphans) notes.push(`${BUN_NO_ORPHANS}=1 set on every spawn (${knobText("noOrphans", NO_ORPHANS_ENV, "true", "1", cfg.noOrphansFrom)
})`);
        return { platform: "darwin", backend: BACKEND_NAME, guarantee: "best-effort", active: true, reason: notes.join("; ") };
      } catch (err) {
        return fail("none", `setup threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
    return memo;
  }

  return {
    platform: "darwin",
    name: BACKEND_NAME,
    get guarantee() {
      return memo?.guarantee ?? "none";
    },
    ensure,
    status: () => memo ?? fail("none", "not configured; configureSpawnCleanup() has not run"),

    /**
     * Every descendant this owner can see, by the same tags as the exit hook (lineage from
     * the owner, this owner's marker prefix, trusted process groups), with the owner and the
     * daemons excluded. Unlike cleanupAll the backend stays fully up: ledger kept, timers
     * kept, later spawns tracked as before. A Worker-thread owner kills only what it spawned.
     */
    killAll() {
      if (!active) return { tracked: false, detail: memo?.reason ?? "backend inactive" };
      try {
        quicken();
        scan(false);
        const r = killTagged(ownerTags());
        refreshAfterKill();
        persist();
        return { tracked: true, detail: `killed ${r.killed.length}` };
      } catch (e) {
        return { tracked: false, detail: `killAll threw: ${e instanceof Error ? e.message : String(e)}` };
      }
    },

    spawnEnv() {
      if (!ensure().active) return undefined;
      pendingSeq = ++seq;
      const own = `${key}-${pendingSeq}`;
      const env: Record<string, string> = { [MARKER_ENV]: inherited ? `${inherited}:${own}` : own };
      if (cfg?.noOrphans) env[BUN_NO_ORPHANS] = "1";
      return env;
    },

    track(proc: SpawnedProcess) {
      if (!active || !proc.pid) return;
      try {
        const s = pendingSeq ?? ++seq;
        pendingSeq = undefined;
        const ids = uniqueIds(proc.pid);
        const info = shortInfo(proc.pid);
        const rec: SpawnRecord = { pid: proc.pid, uid: ids?.uid, seq: s, pgid: info?.pgid === proc.pid ? proc.pid : undefined, exited: false };
        spawns.set(proc.pid, rec);
        if (ids) {
          lineage.set(ids.uid, s);
          lastSeen.set(ids.uid, tick);
          pidOf.set(ids.uid, proc.pid);
        }
        const onExit = () => {
          rec.exited = true;
        };
        proc.exited.then(onExit, onExit);
        scan(false);
        persist();
        quicken();
        if (cfg?.lineageMs === 0) checkDaemon();

      } catch {
        /* tracking is an enhancement; the marker is already in the child's env */
      }
    },

    killTree(pid) {
      if (!active) return { tracked: false, detail: memo?.reason ?? "backend inactive (nothing spawned yet)" };
      const rec = spawns.get(pid);
      if (!rec) return { tracked: false, detail: "pid was not spawned through this library (or is long gone)" };
      try {
        quicken();
        scan(false);
        const roots = new Set<bigint>();
        for (const [u, s] of lineage) if (s === rec.seq) roots.add(u);
        if (rec.uid !== undefined) roots.add(rec.uid);
        const own = `${key}-${rec.seq}`;
        const b = barrier(true);
        b.add(selfUid);
        const pgids = trustedGroups([rec]);
        const pgidOk = pgids.length > 0;
        const r = killTagged({
          lineage: roots,
          marker: (seg) => seg === own,
          pgids,
          excludePids: new Set([process.pid]),
          barrier: b,
        });
        persist();
        return { tracked: true, detail: `SIGKILL ${r.killed.length} process(es) by lineage/marker${pgidOk ? "/pgid" : ""} in ${r.passes} pass(es)` };
      } catch (e) {
        return { tracked: false, detail: `killTree threw: ${e instanceof Error ? e.message : String(e)}` };
      }
    },

    isContained(pid) {
      if (!active) return undefined;
      try {
        const ids = uniqueIds(pid);
        if (!ids) return undefined;
        if (barrier().has(ids.uid)) return false;
        scan(false);
        if (lineage.has(ids.uid)) return true;
        const prefix = `${key}-`;
        return markerSegments(pid)?.some((s) => s.startsWith(prefix)) ?? false;
      } catch {
        return undefined;
      }
    },
  };
}
