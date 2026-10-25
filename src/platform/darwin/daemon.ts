/**
 * The daemon: one process per ledger directory (per user, by default) that turns a
 * SIGKILLed, OOM-killed or crashed owner into an immediate cleanup instead of a delayed one.
 *
 * It needs no pipe to and no relationship with any owner: kqueue EVFILT_PROC works on any
 * same-user pid. Loop:
 *
 *   1. Take `daemon.lock` with flock(LOCK_EX|LOCK_NB), retrying briefly (an owner probing the
 *      lock holds it for microseconds). Held by someone else: exit 0, a daemon is serving.
 *      The kernel drops the lock when the holder dies, so there are no stale locks. Write
 *      `daemon.json` (pid + unique id) for status and for every kill procedure's barrier.
 *   2. Sweep stale ledgers (owners that died before the daemon started).
 *   3. Watch the directory with EVFILT_VNODE/NOTE_WRITE (fires on every create, rename,
 *      delete). For each live owner: NOTE_EXIT + NOTE_FORK on the owner and on every
 *      process in its lineage. On NOTE_FORK, list the forker's children and record any whose
 *      `p_puniqueid` is the forker's unique id, then watch them too. That is event-driven
 *      lineage tracking, microseconds instead of the owner's 250 ms timer, which is what
 *      narrows the fork-then-exit window (it cannot close it: NOTE_TRACK is gone since
 *      10.5, so a child that forks and exits before we list it is never seen).
 *   4. On an owner's NOTE_EXIT: claim its ledger, merge the daemon's lineage set into its
 *      tags, run the kill procedure, delete the ledger.
 *
 * argv hygiene, as for the Linux supervisor: the owner starts it as `bun -` with argv0
 * `bsc-daemon` and the script on stdin, so its command line is `bsc-daemon -`, containing
 * neither "bun" nor the package name: a `pkill -f bun` aimed at an owner does not match it.
 *
 * An auto-started daemon (`idleExitMs` set) exits after that long with no live ledgers, so a
 * machine that stopped using the library does not keep a Bun process forever. It releases
 * the lock BEFORE its last directory check and owners write their ledger BEFORE probing the
 * lock, so an owner arriving at that moment either sees the ledger picked up or the lock free
 * (and starts a new daemon). A daemon started by hand (`bun-spawn-cleanup daemon`) never
 * idles out.
 */
import { appendFileSync, closeSync, openSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  childPids,
  closeFd,
  EV_ADD,
  EV_CLEAR,
  EVFILT_PROC,
  EVFILT_VNODE,
  flock,
  keventRegister,
  keventWait,
  kqueue,
  loadLibSystem,
  libSystemLoadError,
  LOCK_EX,
  LOCK_NB,
  NOTE_EXIT,
  NOTE_FORK,
  NOTE_WRITE,
  openEventOnly,
  uniqueIds,
} from "./ffi.ts";
import {
  DAEMON_FILE,
  daemonInfoJson,
  ensureDir,
  defaultBarrier,
  ledgerPath,
  listLedgers,
  LOCK_FILE,
  readLedger,
  removeQuietly,
  sameProcessAlive,
  sweepOne,
  sweepStale,
} from "./ledger.ts";
import { growLineage, killTagged, snapshot, type ProcRow } from "./procs.ts";

/**
 * Test hook: when set (to a file path), runDaemon appends its pid to that file and fails at
 * once, so the suite can prove owners back off instead of relaunching forever.
 */
export const TEST_FAIL_ENV = "BSC_TEST_DAEMON_FAIL";

/** argv[0] of an auto-started daemon. No "bun", no package name. */
export const DAEMON_ARGV0 = "bsc-daemon";

export interface DaemonOptions {
  dir: string;
  /** Sweep once and return instead of serving. */
  once?: boolean;
  /** Exit after this long with no live ledgers (auto-started daemons). */
  idleExitMs?: number;
  log?: (line: string) => void;
}

interface Owner {
  key: string;
  pid: number;
  uid: bigint;
  mtimeMs: number;
  /** Unique ids known to descend from this owner: ledger contents plus what we saw fork. */
  lineage: Set<bigint>;
  /** Consecutive 1 s refreshes each lineage id was absent from the process list. */
  misses: Map<bigint, number>;
  /**
   * The owner deleted its ledger (its exit hook ran) but its NOTE_EXIT has not arrived yet.
   * Kept so that, once it is gone, descendants only the daemon saw fork are killed too.
   */
  ledgerGone: boolean;
}

/** Try the lock a few times: an owner probing it holds it for microseconds. */
function takeLock(dir: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(join(dir, LOCK_FILE), "a", 0o600);
  } catch {
    return undefined;
  }
  for (let i = 0; i < 10; i++) {
    if (flock(fd, LOCK_EX | LOCK_NB)) return fd;
    Bun.sleepSync(20);
  }
  closeSync(fd);
  return undefined;
}

/** Run the daemon. Returns the process exit code. */
export function runDaemon(opts: DaemonOptions): number {
  const log = opts.log ?? (() => {});
  const { dir } = opts;
  const failFile = process.env[TEST_FAIL_ENV];
  if (failFile) {
    appendFileSync(failFile, `${process.pid}\n`);
    return 1;
  }
  if (!loadLibSystem()) {
    log(`cannot load libSystem: ${libSystemLoadError()}`);
    return 1;
  }
  const dirErr = ensureDir(dir);
  if (dirErr) {
    log(`cannot create ${dir}: ${dirErr}`);
    return 1;
  }

  if (opts.once) {
    for (const r of sweepStale(dir)) log(`swept ${r.owner}: killed ${r.killed.length} process(es)`);
    return 0;
  }

  let lockFd = takeLock(dir);
  if (lockFd === undefined) {
    log("another daemon holds the lock; exiting");
    return 0;
  }
  const self = uniqueIds(process.pid)!;
  const started = Date.now();
  let infoOwners = "";
  const writeInfo = () => {
    try {
      const keys = [...owners.keys()].filter((k) => !owners.get(k)!.ledgerGone).sort();
      infoOwners = keys.join(",");
      writeFileSync(join(dir, DAEMON_FILE), daemonInfoJson(started, keys), { mode: 0o600 });
    } catch {
      /* status shows "not running"; serving does not depend on it */
    }
  };

  const owners = new Map<string, Owner>();

  // Without a kqueue there is no way to learn of owner deaths: give up (owners fall back
  // to their own hooks and the sweep) rather than mistake every failed watch for a death.
  const kq = kqueue();
  if (kq < 0) {
    log("kqueue() failed; exiting");
    closeSync(lockFd);
    return 1;
  }
  writeInfo();
  log(`serving ${dir} as pid ${process.pid}`);
  // Directory events are an optimisation: the loop rescans the directory every second anyway.
  const dirFd = openEventOnly(dir);
  if (dirFd < 0 || !keventRegister(kq, dirFd, EVFILT_VNODE, EV_ADD | EV_CLEAR, NOTE_WRITE)) {
    log("cannot watch the directory; noticing new ledgers by the 1 s rescan only");
  }

  /** Watched pid -> its unique id and the owners whose lineage it belongs to. */
  const watched = new Map<number, { uid: bigint; keys: Set<string> }>();

  const watch = (pid: number, uid: bigint, key: string) => {
    const w = watched.get(pid);
    if (w && w.uid === uid) {
      w.keys.add(key);
      return true;
    }
    if (!keventRegister(kq, pid, EVFILT_PROC, EV_ADD, NOTE_EXIT | NOTE_FORK)) return false;
    // Registered on the pid: confirm it is still the process we meant (pid reuse).
    if (uniqueIds(pid)?.uid !== uid) return false;
    watched.set(pid, { uid, keys: new Set([key]) });
    return true;
  };

  /**
   * Snapshot-based lineage refresh for one owner: watch every live member. With `prune`,
   * drop ids absent for 3 consecutive refreshes (a live member's id is enough to find its
   * future children; the grace covers a child forked just before its parent died and not
   * yet listed).
   */
  const refresh = (o: Owner, rows: ProcRow[] = snapshot(), prune = false) => {
    const known = new Map<bigint, true>();
    for (const u of o.lineage) known.set(u, true);
    for (const r of growLineage(known, rows, new Set([self.uid]))) {
      o.lineage.add(r.uid);
      watch(r.pid, r.uid, o.key);
    }
    if (!prune) return;
    const alive = new Set(rows.map((r) => r.uid));
    for (const u of o.lineage) {
      if (u === o.uid || alive.has(u)) {
        o.misses.delete(u);
        continue;
      }
      const n = (o.misses.get(u) ?? 0) + 1;
      if (n >= 3) {
        o.lineage.delete(u);
        o.misses.delete(u);
      } else o.misses.set(u, n);
    }
  };

  const ownerDied = (o: Owner) => {
    owners.delete(o.key);
    if (o.ledgerGone) {
      // The owner's own exit hook already ran its kill procedure (marker included) and
      // deleted the ledger; finish with what only the daemon saw fork. Confirmed dead by
      // every caller (NOTE_EXIT on a verified pid, or a failed liveness check).
      const r = killTagged({ lineage: new Set(o.lineage), barrier: defaultBarrier(dir), excludePids: new Set([process.pid]) });
      if (r.killed.length) log(`owner ${o.key} exited after its own cleanup: killed ${r.killed.length} more process(es)`);
      return;
    }
    // sweepOne re-checks that the owner is really gone before killing anything.
    const r = sweepOne(dir, `${o.key}.json`, o.lineage);
    if (r) log(`owner ${o.key} exited: killed ${r.killed.length} process(es)`);
  };

  const loadLedger = (key: string, mtimeMs: number) => {
    const l = readLedger(ledgerPath(dir, key));
    if (!l) return;
    let o = owners.get(key);
    if (!o) {
      const uid = BigInt(l.owner.uid);
      o = { key, pid: l.owner.pid, uid, mtimeMs, lineage: new Set([uid]), misses: new Map(), ledgerGone: false };
      owners.set(key, o);
      // Register the owner first; refused or reused means it is already gone.
      if (!sameProcessAlive(o.pid, uid) || !watch(o.pid, uid, key)) {
        ownerDied(o);
        return;
      }
    }
    o.mtimeMs = mtimeMs;
    for (const s of [...l.lineage, ...l.spawns.map((x) => x.uid)]) if (/^\d+$/.test(s)) o.lineage.add(BigInt(s));
    refresh(o);
  };

  const scanDir = () => {
    const present = new Set<string>();
    for (const name of listLedgers(dir)) {
      const key = name.slice(0, -".json".length);
      present.add(key);
      let mtimeMs: number;
      try {
        mtimeMs = statSync(join(dir, name)).mtimeMs;
      } catch {
        continue;
      }
      const o = owners.get(key);
      if (!o || o.mtimeMs !== mtimeMs) loadLedger(key, mtimeMs);
    }
    // A ledger that vanished was deleted by its owner's exit hook. Keep the owner until its
    // NOTE_EXIT (see Owner.ledgerGone), or finish it now if it is already gone.
    for (const [key, o] of owners) {
      if (present.has(key)) continue;
      o.ledgerGone = true;
      if (!sameProcessAlive(o.pid, o.uid)) ownerDied(o);
    }
  };

  const onFork = (pid: number) => {
    const w = watched.get(pid);
    if (!w) return;
    for (const c of childPids(pid)) {
      const ids = uniqueIds(c);
      if (!ids || ids.puid !== w.uid) continue;
      for (const key of w.keys) {
        const o = owners.get(key);
        if (!o) continue;
        o.lineage.add(ids.uid);
        watch(c, ids.uid, key);
      }
    }
  };

  const onExit = (pid: number) => {
    const w = watched.get(pid);
    watched.delete(pid);
    if (!w) return;
    for (const key of w.keys) {
      const o = owners.get(key);
      if (o && o.pid === pid && o.uid === w.uid) ownerDied(o);
    }
  };

  for (const r of sweepStale(dir)) log(`swept ${r.owner}: killed ${r.killed.length} process(es)`);
  scanDir();

  let idleSince = Date.now();
  let lastFull = Date.now();

  /** One wait + bookkeeping round. Returns false when the daemon should exit. */
  const iterate = (): boolean => {
    let dirty = false;
    for (const ev of keventWait(kq, 1000)) {
      if (ev.filter === EVFILT_VNODE) dirty = true;
      else if (ev.filter === EVFILT_PROC) {
        // Forks first: a process that forked and exited in one batch still yields its child.
        if (ev.fflags & NOTE_FORK) onFork(ev.ident);
        if (ev.fflags & NOTE_EXIT) onExit(ev.ident);
      }
    }
    const now = Date.now();
    if (dirty || now - lastFull >= 1000) {
      scanDir();
      if (owners.size) {
        // Safety net for anything an event missed: a full lineage refresh once a second.
        const rows = snapshot();
        for (const o of owners.values()) {
          if (!sameProcessAlive(o.pid, o.uid)) ownerDied(o);
          else refresh(o, rows, true);
        }
      }
      lastFull = now;
    }
    // Drop watch entries for pids that died without us seeing NOTE_EXIT (knote never armed).
    if (watched.size > 4096) for (const [pid, w] of watched) if (uniqueIds(pid)?.uid !== w.uid) watched.delete(pid);

    // Publish which owners are armed (status, tests) whenever that set changes.
    if ([...owners.keys()].filter((k) => !owners.get(k)!.ledgerGone).sort().join(",") !== infoOwners && lockFd !== undefined) writeInfo();

    if (owners.size) idleSince = now;
    else if (opts.idleExitMs !== undefined && now - idleSince >= opts.idleExitMs) {
      // Unlock first, then look once more (see header for why this order is race-free).
      removeQuietly(join(dir, DAEMON_FILE));
      if (lockFd !== undefined) closeSync(lockFd);
      lockFd = undefined;
      scanDir();
      if (owners.size === 0) return false;
      lockFd = takeLock(dir);
      if (lockFd === undefined) return false; // a fresh daemon took over
      writeInfo();
      idleSince = now;
    }
    return true;
  };

  for (;;) {
    try {
      if (!iterate()) break;
    } catch (e) {
      // One bad ledger or a transient fs error must not take the daemon down.
      log(`loop error: ${e instanceof Error ? e.message : String(e)}`);
      Bun.sleepSync(100);
    }
  }
  closeFd(dirFd);
  closeFd(kq);
  log("idle; exiting");
  return 0;
}
