/**
 * The ledger: one small JSON file per live owner, `<dir>/<owner pid>-<owner unique id>.json`
 * (`...t<threadId>.json` for an owner that first spawned from a Worker),
 * holding every tag needed to find the owner's descendants after the owner is gone. The
 * owner rewrites it atomically (temp file + rename) whenever its tags change and deletes it
 * on any exit it can see. A SIGKILLed owner leaves it behind, and whoever finds it next (the
 * daemon at once, otherwise the next owner's `ensure()` or `bun-spawn-cleanup sweep`) runs
 * the kill procedure with its tags and deletes it.
 *
 * Directory: $BUN_SPAWN_CLEANUP_DIR, else $TMPDIR/bun-spawn-cleanup (TMPDIR is per-user on
 * macOS), created 0700. Also holds `daemon.lock` (flock singleton) and `daemon.json`.
 *
 * Every ledger and `daemon.json` carries `kern.bootsessionuuid`. Unique ids restart at boot,
 * so a ledger left by a previous boot (power loss, panic, a persistent BUN_SPAWN_CLEANUP_DIR)
 * names strangers: it is deleted without killing anything.
 *
 * Concurrent sweepers (the daemon and a new owner) claim a ledger by renaming it to
 * `<name>.sweep-<pid>-<unique id>` first; only the winner of the rename kills. A claim whose
 * claimer died mid-sweep is re-claimed by the next sweeper.
 */
import { closeSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootSessionId, flock, LOCK_EX, LOCK_NB, LOCK_UN, uniqueIds } from "./ffi.ts";
import { killTagged } from "./procs.ts";

export const DIR_ENV = "BUN_SPAWN_CLEANUP_DIR";
export const LOCK_FILE = "daemon.lock";
export const DAEMON_FILE = "daemon.json";

export interface LedgerSpawn {
  pid: number;
  /** Unique id as a decimal string (JSON has no bigint). Empty when it could not be read. */
  uid: string;
  seq: number;
  /** Process group to kill, only when the caller spawned the child `detached`. */
  pgid?: number;
}

export interface Ledger {
  version: 1;
  owner: { pid: number; uid: string };
  /** Owner key `<pid>-<uid>`: every marker segment of this owner starts with `<key>-`. */
  marker: string;
  created: number;
  /** `kern.bootsessionuuid` of the boot that wrote it. */
  boot: string;
  spawns: LedgerSpawn[];
  /** Unique ids known to descend from the owner (including the owner itself). */
  lineage: string[];
  /** Unique ids that must never be killed or walked through (a daemon this owner started). */
  exclude: string[];
}

export interface DaemonInfo {
  pid: number;
  uid: string;
  started: number;
  boot?: string;
  /** Owner keys whose NOTE_EXIT the daemon has armed (for status and tests). */
  owners?: string[];
}

/**
 * The ledger directory: `override` (the `darwin.ledgerDir` option) when given and non-empty,
 * else BUN_SPAWN_CLEANUP_DIR, else `$TMPDIR/bun-spawn-cleanup`.
 */
export function ledgerDir(override?: string): string {
  if (override) return override;
  const env = process.env[DIR_ENV];
  if (env) return env;

  return join(process.env.TMPDIR || tmpdir(), "bun-spawn-cleanup");
}

/** Create the directory 0700. Returns an error string on failure. */
export function ensureDir(dir: string): string | undefined {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export const ownerKey = (pid: number, uid: bigint | string) => `${pid}-${uid}`;
export const ledgerPath = (dir: string, key: string) => join(dir, `${key}.json`);

const LEDGER_RE = /^(\d+)-(\d+)(?:t\d+)?\.json$/;
const CLAIM_RE = /^(\d+-\d+(?:t\d+)?\.json)\.sweep-(\d+)-(\d+)$/;
const TMP_RE = /^\d+-\d+(?:t\d+)?\.json\.(\d+)\.tmp$/;

/** Atomic rewrite. Never throws; returns false on failure. */
export function writeLedger(path: string, ledger: Ledger): boolean {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(ledger), { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return false;
  }
}

export function readLedger(path: string): Ledger | undefined {
  try {
    const l = JSON.parse(readFileSync(path, "utf8")) as Ledger;
    if (l?.version !== 1 || typeof l.owner?.pid !== "number" || !/^\d+$/.test(String(l.owner.uid))) return undefined;
    if (typeof l.marker !== "string" || !l.marker) return undefined;
    return { ...l, spawns: l.spawns ?? [], lineage: l.lineage ?? [], exclude: l.exclude ?? [] };
  } catch {
    return undefined;
  }
}

export function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/** Is the process `pid` alive AND still the one with unique id `uid`? */
export function sameProcessAlive(pid: number, uid: string | bigint): boolean {
  const ids = uniqueIds(pid);
  return !!ids && String(ids.uid) === String(uid);
}

export function readDaemonInfo(dir: string): DaemonInfo | undefined {
  try {
    const d = JSON.parse(readFileSync(join(dir, DAEMON_FILE), "utf8")) as DaemonInfo;
    return typeof d.pid === "number" && typeof d.uid === "string" ? d : undefined;
  } catch {
    return undefined;
  }
}

/** The running daemon, verified by boot + pid + unique id, or undefined. */
export function liveDaemon(dir: string): DaemonInfo | undefined {
  const d = readDaemonInfo(dir);
  return d && d.boot === bootSessionId() && sameProcessAlive(d.pid, d.uid) ? d : undefined;
}

/** Contents for `daemon.json` describing the calling process. */
export function daemonInfoJson(started: number, owners: string[]): string {
  const info: DaemonInfo = { pid: process.pid, uid: String(uniqueIds(process.pid)?.uid ?? 0n), started, boot: bootSessionId(), owners };
  return JSON.stringify(info);
}

/**
 * Probe `daemon.lock`: `free` (no daemon holds it), `held`, or `error` (cannot open or
 * flock it at all). Takes and drops the lock in microseconds; a daemon starting in that
 * window retries (see daemon.ts).
 */
export function probeDaemonLock(dir: string): "free" | "held" | "error" {
  let fd = -1;
  try {
    fd = openSync(join(dir, LOCK_FILE), "a", 0o600);
    if (!flock(fd, LOCK_EX | LOCK_NB)) return "held";
    flock(fd, LOCK_UN);
    return "free";
  } catch {
    return "error";
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

/** Kill-procedure tags for a dead owner's ledger. */
export function ledgerTags(l: Ledger, barrier: Set<bigint>, extraLineage?: Iterable<bigint>) {
  const lineage = new Set<bigint>();
  const add = (s: string) => {
    if (/^\d+$/.test(s)) lineage.add(BigInt(s));
  };
  add(l.owner.uid);
  l.lineage.forEach(add);
  for (const s of l.spawns) add(s.uid);
  for (const u of extraLineage ?? []) lineage.add(u);
  for (const s of l.exclude) if (/^\d+$/.test(s)) barrier.add(BigInt(s));
  const prefix = `${l.marker}-`;
  return {
    lineage,
    marker: (seg: string) => seg.startsWith(prefix),
    pgids: trustedGroups(l.spawns),
    barrier,
    excludePids: new Set([process.pid]),
  };
}

/**
 * Recorded process groups that may still be killed: only while the leader (the detached
 * child, pgid == pid) is alive and still the same process. Once the leader is gone its pid,
 * and so the group id, can be reused by a stranger's group; members of the original group
 * are still covered by lineage and marker.
 */
export function trustedGroups(spawns: Array<{ pid: number; uid?: string | bigint; pgid?: number }>): number[] {
  return spawns.filter((s) => s.pgid && s.uid !== undefined && s.uid !== "" && sameProcessAlive(s.pid, s.uid)).map((s) => s.pgid!);
}

/**
 * Unique ids no kill procedure may touch or walk through: the current daemon, and every
 * daemon some live owner started (a daemon is its starter's descendant, and an OUTER owner
 * of that starter would otherwise see it in its lineage before it has written daemon.json).
 */
export function daemonBarrier(dir: string): Set<bigint> {
  const b = new Set<bigint>();
  const d = readDaemonInfo(dir);
  if (d && /^\d+$/.test(d.uid)) b.add(BigInt(d.uid));
  const boot = bootSessionId();
  for (const name of listLedgers(dir)) {
    const l = readLedger(join(dir, name));
    if (l && l.boot === boot) for (const u of l.exclude) if (/^\d+$/.test(u)) b.add(BigInt(u));
  }
  return b;
}

/** Barrier set for any sweeper: itself and every daemon. */
export function defaultBarrier(dir: string): Set<bigint> {
  const b = daemonBarrier(dir);
  const self = uniqueIds(process.pid);
  if (self) b.add(self.uid);
  return b;
}

export interface SweepEntry {
  owner: string;
  killed: number[];
}

/**
 * Claim a dead owner's ledger, kill its tree, delete it. `file` is the ledger's base name
 * (`<key>.json`) or an abandoned claim. Returns undefined when someone else holds the claim.
 */
export function sweepOne(
  dir: string,
  file: string,
  extraLineage?: Iterable<bigint>,
  opts: { ownerAlive?: "refuse" | "ignore" } = {},
): SweepEntry | undefined {
  const self = uniqueIds(process.pid);
  const base = CLAIM_RE.exec(file)?.[1] ?? file;
  const claim = join(dir, `${base}.sweep-${process.pid}-${self?.uid ?? 0}`);
  try {
    renameSync(join(dir, file), claim);
  } catch {
    return undefined; // claimed or deleted by someone else
  }
  const l = readLedger(claim);
  if (opts.ownerAlive !== "ignore" && l && l.boot === bootSessionId() && sameProcessAlive(l.owner.pid, l.owner.uid)) {
    // Not dead after all (a caller misjudged): put it back, never kill a live owner's tree.
    // link() fails if the owner has meanwhile written a newer ledger: keep that one.
    try {
      linkSync(claim, join(dir, base));
    } catch {
      /* newer ledger in place, or the owner rewrites it on its next change */
    }
    removeQuietly(claim);
    return undefined;
  }
  const result: SweepEntry = { owner: base.replace(/\.json$/, ""), killed: [] };
  // Unreadable, or from another boot (its ids name strangers now): delete, kill nothing.
  if (l !== undefined && l.boot === bootSessionId()) result.killed = killTagged(ledgerTags(l, defaultBarrier(dir), extraLineage)).killed;
  removeQuietly(claim);
  return result;
}

/** Ledgers of Worker-thread owners of the process `<pid>-<uid>` (base names). */
export function threadLedgers(dir: string, processKey: string): string[] {
  return listLedgers(dir).filter((n) => n.startsWith(`${processKey}t`));
}

/** Every ledger file in `dir` (base names), live or not. */
export function listLedgers(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => LEDGER_RE.test(n));
  } catch {
    return [];
  }
}

/**
 * Sweep every ledger whose owner is gone (pid dead, or alive with another unique id), plus
 * claims abandoned by a dead sweeper and temp files of dead writers. `skip` is a ledger key
 * never to touch (the caller's own).
 */
export function sweepStale(dir: string, skip?: string): SweepEntry[] {
  const out: SweepEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const m = LEDGER_RE.exec(name);
    if (m) {
      if (name === `${skip}.json` || sameProcessAlive(Number(m[1]), m[2]!)) continue;
      const r = sweepOne(dir, name);
      if (r) out.push(r);
      continue;
    }
    const c = CLAIM_RE.exec(name);
    if (c) {
      if (sameProcessAlive(Number(c[2]), c[3]!)) continue;
      const r = sweepOne(dir, name);
      if (r) out.push(r);
      continue;
    }
    const t = TMP_RE.exec(name);
    if (t && !uniqueIds(Number(t[1]))) removeQuietly(join(dir, name));
  }
  return out;
}
