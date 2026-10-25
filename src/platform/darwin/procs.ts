/**
 * Process scans and the one kill procedure shared by the owner, the sweep and the daemon.
 *
 * A process belongs to a tree when ANY of three tags says so:
 *
 * - lineage: its `p_uniqueid` is in a known set, or its `p_puniqueid` (the unique id of the
 *   process that created it) is. The kernel sets both and they never change on `setsid`,
 *   `env -i` or reparenting to launchd, and unique ids are never reused before reboot. The
 *   walk is a BFS from the known set over "created by" edges, so it reaches descendants
 *   whose parents already exited AS LONG AS some scan saw each intermediate alive.
 * - marker: one `:`-separated segment of its BUN_SPAWN_CLEANUP_ID (read back through
 *   KERN_PROCARGS2, same user only) matches. Survives exits of intermediates; lost to
 *   `env -i` or any spawn with a replaced env.
 * - process group: it is a member of a recorded pgid. Only recorded for spawns the caller
 *   made `detached` (pgid == child pid); see index.ts for why the backend does not force it.
 *
 * Everything here is synchronous (it runs inside `process.on("exit")`) and never throws.
 */
import {
  allPids,
  pgrpPids,
  procEnv,
  SIGCONT,
  SIGKILL,
  SIGSTOP,
  sendSignal,
  uniqueIds,
  type UniqueIds,
} from "./ffi.ts";

/** Inherited marker every spawn carries. Colon-separated when owners nest. */
export const MARKER_ENV = "BUN_SPAWN_CLEANUP_ID";

export interface ProcRow extends UniqueIds {
  pid: number;
}

/** One pass over every pid: who exists and who created whom. Zombies are absent. */
export function snapshot(): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const pid of allPids()) {
    const ids = uniqueIds(pid);
    if (ids) rows.push({ pid, ...ids });
  }
  return rows;
}

/**
 * Grow `known` (unique id -> tag, e.g. the spawn seq it descends from) with every row whose
 * creator is known; a new member inherits its creator's tag. `barrier` ids never join (the
 * daemon, the caller itself), so the walk never passes through them. Returns the rows that
 * are members after the walk.
 */
export function growLineage<T>(known: Map<bigint, T>, rows: ProcRow[], barrier?: ReadonlySet<bigint>): ProcRow[] {
  const byCreator = new Map<bigint, ProcRow[]>();
  for (const r of rows) {
    const list = byCreator.get(r.puid);
    if (list) list.push(r);
    else byCreator.set(r.puid, [r]);
  }
  const queue = [...known.keys()];
  while (queue.length) {
    const u = queue.pop()!;
    const tag = known.get(u)!;
    for (const r of byCreator.get(u) ?? []) {
      if (known.has(r.uid) || barrier?.has(r.uid)) continue;
      known.set(r.uid, tag);
      queue.push(r.uid);
    }
  }
  return rows.filter((r) => known.has(r.uid));
}

/** Segments of a BUN_SPAWN_CLEANUP_ID value in `env`, or `undefined` if the env is unreadable. */
export function markerSegments(pid: number): string[] | undefined {
  const env = procEnv(pid);
  if (!env) return undefined;
  const prefix = `${MARKER_ENV}=`;
  const entry = env.find((e) => e.startsWith(prefix));
  return entry ? entry.slice(prefix.length).split(":") : [];
}

export interface Tags {
  /** Known unique ids (lineage roots); grown in place by the scan. */
  lineage: Set<bigint>;
  /** Marker match: true when one segment belongs to the tree. */
  marker?: (segment: string) => boolean;
  /** Process groups whose members belong to the tree. */
  pgids?: number[];
  /** Pids never touched (the caller). */
  excludePids?: ReadonlySet<number>;
  /** Unique ids never touched and never walked through (the daemon, the caller). */
  barrier?: ReadonlySet<bigint>;
}

/** Every live process the tags match, pid -> unique id. One pass; grows `tags.lineage`. */
export function collect(tags: Tags, rows: ProcRow[] = snapshot()): Map<number, bigint> {
  const out = new Map<number, bigint>();
  const skip = (r: { pid: number; uid: bigint }) => tags.excludePids?.has(r.pid) || tags.barrier?.has(r.uid);
  const asMap = new Map<bigint, true>();
  for (const u of tags.lineage) asMap.set(u, true);
  for (const r of growLineage(asMap, rows, tags.barrier)) if (!skip(r)) out.set(r.pid, r.uid);
  for (const u of asMap.keys()) tags.lineage.add(u);

  for (const pg of tags.pgids ?? []) {
    for (const pid of pgrpPids(pg)) {
      const ids = uniqueIds(pid);
      if (ids && !skip({ pid, uid: ids.uid })) out.set(pid, ids.uid);
    }
  }

  if (tags.marker) {
    for (const r of rows) {
      if (out.has(r.pid) || skip(r)) continue;
      if (markerSegments(r.pid)?.some(tags.marker)) out.set(r.pid, r.uid);
    }
  }
  return out;
}

/**
 * SIGSTOP every match so the tree stops growing, re-check each pid's unique id, then SIGKILL
 * the verified ones. The id is checked BEFORE the stop too, so a pid reused by a stranger
 * since the scan is never signalled at all; one reused in the microseconds between that
 * check and the stop is resumed (SIGCONT) only if the pre-stop check had matched, i.e. only
 * if we are the ones who stopped it. Returns the pids killed.
 */
function stopVerifyKill(matches: Map<number, bigint>): number[] {
  const stopped = new Map<number, bigint>();
  for (const [pid, uid] of matches) {
    if (uniqueIds(pid)?.uid !== uid) continue;
    if (sendSignal(pid, SIGSTOP)) stopped.set(pid, uid);
  }
  const killed: number[] = [];
  for (const [pid, uid] of stopped) {
    if (uniqueIds(pid)?.uid !== uid) {
      sendSignal(pid, SIGCONT);
      continue;
    }
    if (sendSignal(pid, SIGKILL)) killed.push(pid);
  }
  return killed;
}

export interface KillResult {
  killed: number[];
  passes: number;
}

/**
 * The kill procedure: collect, stop, verify, kill, rescan, until two consecutive passes find
 * nothing (40 passes max, as the Linux marker supervisor does). Killed processes' unique ids
 * stay in the lineage set, so children they forked mid-pass are found by the next one.
 */
export function killTagged(tags: Tags, maxPasses = 40): KillResult {
  const done = new Set<bigint>();
  const killed: number[] = [];
  let idle = 0;
  let passes = 0;
  while (idle < 2 && passes < maxPasses) {
    passes++;
    const matches = collect(tags);
    for (const [pid, uid] of matches) if (done.has(uid)) matches.delete(pid);
    if (matches.size === 0) {
      idle++;
      continue;
    }
    idle = 0;
    for (const uid of matches.values()) done.add(uid);
    killed.push(...stopVerifyKill(matches));
    // Let forks that were in flight when their parent stopped show up in the next listing.
    Bun.sleepSync(5);
  }
  return { killed, passes };
}
