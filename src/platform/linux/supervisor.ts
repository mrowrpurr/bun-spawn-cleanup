/**
 * The supervisor: a detached `/bin/sh` that outlives the owner and performs the cleanup.
 *
 * Why a shell and not a compiled helper or a second Bun process: `sh`, `cat`, `find`,
 * `grep` and `kill` exist on every Linux the library can run on, the scripts are a few
 * hundred bytes, and the supervisor costs one `sh` plus one `cat` while idle. A Bun helper
 * would cost tens of megabytes per owner; a native helper would need a per-arch build.
 *
 * How it learns that the owner died: its stdin is a pipe whose only other end is held by
 * the owner (Bun creates it close-on-exec, verified: no later child inherits it). EOF means
 * the owner is gone, by any means: SIGKILL, OOM kill, clean exit, uncaught throw. Only then
 * does the script act. There is no polling and no pid reuse problem. The supervisor is
 * spawned `detached` (own session) so a Ctrl-C or SIGHUP aimed at the owner's terminal
 * group does not take it down with the owner.
 *
 * The containment is kernel-enforced (cgroup) but the TRIGGER is this userland process. In
 * cgroup mode with Landlock signal scoping (kernel 6.12+) no descendant can signal it; an
 * unrelated process of the same user still can. The owner notices and restarts it (see
 * `watchSupervisor` in index.ts).
 */

/**
 * cgroup mode. Configuration arrives as the FIRST LINE on stdin: `<cgroup-dir> <owner-pid>
 * <owner-start-time>` (start time = /proc/<pid>/stat field 22, defeats pid reuse). Nothing
 * identifying goes in argv on purpose: argv is `bsc-supervisor <token>` and the script text
 * contains no "bun", so a `pkill -f bun` or `pkill -f <your service name>` aimed at the owner
 * cannot match the supervisor through a cgroup path or unit name.
 *
 * While the owner lives, further stdin lines are commands, because once the owner has
 * applied Landlock it can no longer write to cgroupfs itself and this process (started
 * before the ruleset, so outside it) does the writes on its behalf:
 *   track <pid>   create c-<pid> and move <pid> into it (per-spawn cgroup for killTree);
 *                 refused unless <pid>'s parent is the owner, so a reused pid is never moved
 *   kill <pid>    write 1 to c-<pid>/cgroup.kill
 *   rmdir <pid>   remove an emptied c-<pid>
 *   killall 0     killTree() with no argument: cgroup.kill every c-*, then SIGKILL every
 *                 direct member except the owner and this session. Done here because
 *                 adopted processes (moved in before Landlock) are outside the owner's
 *                 sandbox, and signal scoping refuses the owner's own SIGKILL for them
 * Commands are serialized by the pipe, so a `kill` always lands after its `track`.
 *
 * Two independent death detectors, either of which runs `finish`:
 *   - EOF on stdin (instant). `read` can also fail on a signal, so EOF is only trusted
 *     once /proc confirms the owner is gone.
 *   - A background poller (a subshell, second process in the same session) checking
 *     /proc/<owner>/stat once a second: same start time and state not Z/X (a zombie owner
 *     whose parent is slow to reap is dead for our purposes). Covers anything that could
 *     keep the pipe open after the owner is gone, and a stopped or killed main shell. Bun's
 *     stdin pipe is a socketpair, which cannot be reopened through /proc/<pid>/fd (ENXIO),
 *     but the poller does not rely on that. Cost: the stat parsing is shell builtins, so
 *     the only per-second work is one `sleep 1` fork+exec.
 *
 * `finish`: write `1` to `cgroup.kill` (the kernel SIGKILLs every process in the subtree,
 * atomically, including ones forked concurrently) and remove the now-empty cgroup
 * directories, deepest first. rmdir fails with EBUSY until the kernel has finished tearing
 * processes down, hence the retry loop (10 s cap). Idempotent, so both detectors may run it.
 *
 * Restarted supervisors (see index.ts): an owner that has applied Landlock can only start a
 * supervisor INSIDE its own cgroup and sandbox, where cgroupfs writes are refused. Every
 * write therefore has a fallback that needs only reads and signals, which the sandbox allows
 * within its own domain: `sigsweep` SIGKILLs every member listed in the tree's
 * `cgroup.procs` files except this supervisor's own session (it is a session leader, so its
 * poller, `sleep`s and `find`s share its sid), pass after pass until a pass finds nothing;
 * a process forked meanwhile is born inside the cgroup, so the next pass sees it. The
 * directories are then left for the next owner's setup sweep or `bun-spawn-cleanup sweep`.
 */
export const CGROUP_SUPERVISOR = `
read -r cg owner start || exit 0
alive() {
  read -r line < "/proc/$owner/stat" 2>/dev/null || return 1
  set -- \${line##*) }
  [ "\${20}" = "$start" ] || return 1
  case $1 in Z|X) return 1 ;; esac
  return 0
}
sigsweep() {
  sd=$1
  n=0
  while [ $n -lt 40 ]; do
    hit=0
    for p in $(find "$sd" -name cgroup.procs -exec cat {} + 2>/dev/null); do
      read -r line < "/proc/$p/stat" 2>/dev/null || continue
      set -- \${line##*) }
      [ "$4" = "$$" ] && continue
      kill -9 "$p" 2>/dev/null && hit=1
    done
    [ $hit = 0 ] && return 0
    n=$((n+1))
    sleep 0.05 2>/dev/null || sleep 1
  done
  return 0
}
finish() {
  [ -d "$cg" ] || return 0
  if echo 1 > "$cg/cgroup.kill" 2>/dev/null; then tries=200; else sigsweep "$cg"; tries=10; fi
  i=0
  while [ -d "$cg" ] && [ $i -lt $tries ]; do
    find "$cg" -depth -type d -exec rmdir {} \\; 2>/dev/null
    [ -d "$cg" ] || return 0
    i=$((i+1))
    sleep 0.05 2>/dev/null || sleep 1
  done
  return 1
}
( while alive; do sleep 1; done; finish ) &
poller=$!
while :; do
  if read -r cmd arg; then
    case $arg in ''|*[!0-9]*) continue ;; esac
    case $cmd in
      track)
        read -r line < "/proc/$arg/stat" 2>/dev/null || continue
        set -- \${line##*) }
        [ "$2" = "$owner" ] || continue
        [ -d "$cg/c-$arg" ] || mkdir "$cg/c-$arg" 2>/dev/null || continue
        echo "$arg" > "$cg/c-$arg/cgroup.procs" 2>/dev/null || rmdir "$cg/c-$arg" 2>/dev/null ;;
      kill)
        echo 1 > "$cg/c-$arg/cgroup.kill" 2>/dev/null || { [ -d "$cg/c-$arg" ] && sigsweep "$cg/c-$arg"; } ;;
      rmdir) rmdir "$cg/c-$arg" 2>/dev/null ;;
      killall)
        for c in "$cg"/c-*; do
          [ -d "$c" ] || continue
          echo 1 > "$c/cgroup.kill" 2>/dev/null || sigsweep "$c"
        done
        for p in $(cat "$cg/cgroup.procs" 2>/dev/null); do
          [ "$p" = "$owner" ] && continue
          read -r line < "/proc/$p/stat" 2>/dev/null || continue
          set -- \${line##*) }
          [ "$4" = "$$" ] && continue
          kill -9 "$p" 2>/dev/null
        done ;;
    esac
  else
    alive || break
    sleep 0.1 2>/dev/null || sleep 1
  fi
done
finish
rc=$?
kill $poller 2>/dev/null
exit $rc
`;

/**
 * Best-effort mode (the owner is a child subreaper, see subreaper.ts). First stdin line:
 * `<env var name> <marker id> <owner-pid> <owner-start-time>`.
 *
 * While the owner lives, the poller subshell snapshots the owner's descendant set once a
 * second: one pass over /proc/<pid>/stat (shell builtins only), then a fixpoint over the
 * parent links from the owner pid. Each member is recorded as `pid:starttime` so a pid that
 * is later recycled is never mistaken for a member. Snapshots alternate between two files so
 * an interrupted write never loses the previous one; `finish` reads both. Further stdin
 * lines are commands:
 *   track <pid>   record a library spawn (`pid:starttime`) at once, so a direct child spawned
 *                 less than a second before the owner's death is not missed
 * This supervisor's own processes (it is a session leader: main shell, poller, `sleep`,
 * `grep`) are excluded by session id everywhere.
 *
 * `finish` (on EOF confirmed by /proc, or by the poller; a lock directory makes it run once):
 *   1. seeds = every recorded `pid:starttime` still alive with that start time, plus every
 *      process whose environ carries the marker (the second net: callers that passed
 *      `{ ...process.env }`);
 *   2. freeze: SIGSTOP the seeds and everything whose live parent chain reaches one, re-walk,
 *      stop the newcomers, until a walk finds nothing new (20 rounds max). A stopped process
 *      cannot fork and its children cannot reparent away while it is alive, so the walk is
 *      race-free; then SIGKILL the whole frozen set;
 *   3. marker net: rescan /proc/<pid>/environ for the marker and SIGKILL matches until two
 *      consecutive passes find nothing (40 passes max).
 *
 * The owner's direct children reparent to init (or an outer subreaper) the moment it dies,
 * which is why the snapshot, not a walk at death time, is the source of truth for them.
 * Still best-effort: a descendant created and orphaned less than a second before the owner
 * died, by an API other than the library's `spawn`, is in no snapshot, and a deliberate
 * `setsid` + supervisor kill escapes. Cost while idle: one /proc pass per second in `sh`.
 *
 * `grep -z` (NUL-separated lines, GNU and busybox) is used when available, else a `tr`
 * fallback. Processes of other users are unreadable and silently skipped: they cannot be
 * our descendants anyway unless something setuid'd, and we could not kill them regardless.
 */
export const MARKER_SUPERVISOR = `
read -r name id owner start || exit 0
d=$(mktemp -d "\${TMPDIR:-/tmp}/bsc-sup.XXXXXX" 2>/dev/null) || { d="\${TMPDIR:-/tmp}/bsc-sup.$$"; mkdir -p "$d" 2>/dev/null; }
alive() {
  read -r line < "/proc/$owner/stat" 2>/dev/null || return 1
  set -- \${line##*) }
  [ "\${20}" = "$start" ] || return 1
  case $1 in Z|X) return 1 ;; esac
  return 0
}
if printf 'A=1\\0' | grep -qz '^A=1' 2>/dev/null; then
  marked() { grep -lz "^$name=.*$id" /proc/[0-9]*/environ 2>/dev/null; }
else
  marked() { for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$f" 2>/dev/null | grep -q "^$name=.*$id" && echo "$f"; done; }
fi
table() {
  P=" "
  for f in /proc/[0-9]*/stat; do
    read -r line < "$f" 2>/dev/null || continue
    p=\${line%% *}
    set -- \${line##*) }
    [ "$4" = "$$" ] && continue
    P="$P$p:\${20}:$2 "
  done
}
closure() {
  M=" $1 "
  more=1
  while [ $more = 1 ]; do
    more=0
    for e in $P; do
      p=\${e%%:*}
      case $M in *" $p "*) continue ;; esac
      case $M in *" \${e##*:} "*) M="$M$p "; more=1 ;; esac
    done
  done
}
slot=0
snapshot() {
  table
  closure "$owner"
  S=""
  for e in $P; do
    p=\${e%%:*}
    [ "$p" = "$owner" ] && continue
    case $M in *" $p "*) r=\${e#*:}; S="$S $p:\${r%%:*}" ;; esac
  done
  slot=$((1-slot))
  printf '%s\\n' "$S" > "$d/s$slot" 2>/dev/null
}
finish() {
  mkdir "$d/lock" 2>/dev/null || return 3
  seeds=$(cat "$d/s0" "$d/s1" "$d/t" 2>/dev/null)
  table
  live=""
  for t in $seeds; do
    case $P in *" $t:"*) live="$live \${t%%:*}" ;; esac
  done
  for f in $(marked); do p=\${f#/proc/}; live="$live \${p%/environ}"; done
  stopped=" "
  if [ -n "$live" ]; then
    closure "$live"
    n=0
    while [ $n -lt 20 ]; do
      new=0
      for p in $M; do
        case $stopped in *" $p "*) continue ;; esac
        [ "$p" -gt 1 ] 2>/dev/null || continue
        [ "$p" = "$owner" ] && continue
        [ "$p" = "$$" ] && continue
        kill -STOP "$p" 2>/dev/null
        stopped="$stopped$p "
        new=1
      done
      [ $new = 0 ] && break
      table
      closure "$stopped"
      n=$((n+1))
    done
    for p in $stopped; do kill -9 "$p" 2>/dev/null; done
  fi
  rounds=0
  idle=0
  while [ $idle -lt 2 ] && [ $rounds -lt 40 ]; do
    hit=0
    for f in $(marked); do
      p=\${f#/proc/}
      p=\${p%/environ}
      [ "$p" = "$$" ] && continue
      kill -9 "$p" 2>/dev/null && hit=1
    done
    if [ $hit = 1 ]; then idle=0; else idle=$((idle+1)); fi
    rounds=$((rounds+1))
    sleep 0.05 2>/dev/null || sleep 1
  done
  rm -rf "$d" 2>/dev/null
  return 0
}
( while alive; do snapshot; sleep 1; done; finish ) &
poller=$!
while :; do
  if read -r cmd arg; then
    case $arg in ''|*[!0-9]*) continue ;; esac
    case $cmd in
      track)
        read -r line < "/proc/$arg/stat" 2>/dev/null || continue
        set -- \${line##*) }
        [ "$2" = "$owner" ] || continue
        echo "$arg:\${20}" >> "$d/t" 2>/dev/null ;;
    esac
  else
    alive || break
    sleep 0.1 2>/dev/null || sleep 1
  fi
done
finish
[ $? = 3 ] && wait $poller
kill $poller 2>/dev/null
exit 0
`;

/**
 * argv[0] of the supervisor shell. Deliberately contains neither "bun" nor the package name
 * so that a `pkill -f bun` aimed at the owner does not take the supervisor with it.
 */
export const SUPERVISOR_ARGV0 = "bsc-supervisor";

export interface Supervisor {
  readonly pid: number;
  /** Never close this: closing stdin is the death signal. Kept so the pipe stays referenced. */
  readonly proc: Bun.Subprocess;
  /** Write one command line to the supervisor. Never throws, even when it is gone. */
  send(line: string): void;
  /**
   * Tear the supervisor down without triggering cleanup (setup failed after it started, or a
   * restart replaced it): SIGKILL its whole process group (detached, so pgid == pid), which
   * takes its poller too. A sandboxed owner may get EPERM for a supervisor outside the
   * sandbox; that is ignored.
   */
  abort(): void;
}

/**
 * Start a supervisor running `script`; `token` is its only argv (for tests to find it) and
 * `config` is written as the first stdin line. The returned object MUST be kept referenced
 * for the life of the owner so Bun never garbage-collects the stdin pipe.
 * Throws if `/bin/sh` cannot be spawned; the caller turns that into an inactive status.
 */
export function startSupervisor(script: string, token: string, config: string, env: Record<string, string>): Supervisor {
  const proc = Bun.spawn(["/bin/sh", "-c", script, SUPERVISOR_ARGV0, token], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
    env,
  });
  // The supervisor must not keep the owner's event loop alive: an owner that is done should
  // exit, and that exit is exactly what the supervisor is waiting for.
  proc.unref();
  // A dead supervisor leaves a broken pipe; a write must never throw or leave an unhandled
  // rejection in the owner.
  const send = (line: string) => {
    try {
      const sink = proc.stdin as Bun.FileSink;
      sink.write(line + "\n");
      const r = sink.flush() as unknown;
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      /* supervisor gone */
    }
  };
  send(config);
  return {
    pid: proc.pid,
    proc,
    send,
    abort() {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    },
  };
}
