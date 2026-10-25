# macOS

Backend: `darwin-best-effort`. Guarantee: always `best-effort`.

## Mechanism

macOS has no unprivileged kernel grouping (coalitions need a private entitlement) and nothing
stops a same-user process from leaving a group or killing a watchdog. The backend therefore
tags every process three ways (kernel lineage ids, env marker, process group), writes the
tags to a ledger, and three triggers act on them when the owner dies (owner hooks, daemon,
sweep). Seatbelt is not used: it limits what a process can reach, not whether it can leave
the tree.

### Kernel lineage ids

Every process has a 64-bit `p_uniqueid` (never reused before reboot) and `p_puniqueid`, the
unique id of the process that created it (`proc_pidinfo(PROC_PIDUNIQIDENTIFIERINFO)`).
Neither changes on `setsid`, `env -i` or reparenting to launchd.

The owner keeps the set of ids descending from it current at every `spawn()` and, while no
daemon serves, on an unref'd timer. The timer walks `proc_listchildpids` down the owner's own
subtree, and lists every pid only when a member died or every 2 s; it starts at 250 ms and
doubles up to 2 s while nothing changes. The daemon tracks forks itself, so with one serving
the owner only re-checks it every 2 s. A walk over "created by" edges from that set
finds descendants whose parents already exited, as long as each intermediate was seen alive
once.

### Env marker

Every `spawn()` gets `BUN_SPAWN_CLEANUP_ID=<owner pid>-<owner unique id>-<seq>` merged into
its environment (nested owners append `:<their id>`), read back from any same-user process
with `sysctl(KERN_PROCARGS2)`, what `ps -E` uses. Survives intermediates exiting; lost to
`env -i`.

### Process group

Only for spawns you made `detached` yourself, and only while that child (the group leader)
is alive.

### Ledger

The owner writes its tags to a **ledger**, `$TMPDIR/bun-spawn-cleanup/<pid>-<unique id>.json`
(atomic rename, directory 0700, stamped with `kern.bootsessionuuid`: unique ids restart at
boot, so a ledger from a previous boot is deleted without killing anything). The directory is
set by `darwin.ledgerDir` / `BUN_SPAWN_CLEANUP_DIR` (see
[Options and environment knobs](../README.md#options-and-environment-knobs)).

Three triggers act on the tags, all running the same procedure: collect matches, check each
pid's unique id, `SIGSTOP` them, check again (a reused pid is never signalled, or resumed at
once if it changed hands mid-stop), `SIGKILL`, rescan until two passes find nothing.

### Owner hooks

The owner itself, immediately: `process.on("exit")` (clean exit, `process.exit`, uncaught
exception, unhandled rejection) and SIGINT/SIGTERM/SIGHUP/SIGQUIT. The signal hooks kill the
tree, then re-raise with the default disposition, so the exit status is unchanged; if your
app has its own listener for that signal, the hook does nothing and your listener decides. A
signal the process inherited as ignored (`nohup` ignores SIGHUP; a background job of a
non-interactive shell ignores SIGINT and SIGQUIT) gets no hook at all, so it stays ignored.

### Daemon

The daemon, immediately, for deaths the owner cannot see (SIGKILL, jetsam, a native crash).
The first `spawn()` starts one per ledger directory when none holds `daemon.lock` (flock). It
watches the directory with kqueue `EVFILT_VNODE`, puts `NOTE_EXIT` + `NOTE_FORK` on every
owner and every known descendant (forks are tracked in microseconds instead of 250 ms), and
runs the procedure from the ledger when an owner exits. Its command line is `bsc-daemon -`
(script on stdin), so `pkill -f bun` aimed at your app misses it. It exits after 60 s with no
live owners; a live owner restarts it within ~2 s if something kills it. A start counts only
once `daemon.json` names a live daemon of this boot (the first `spawn()` waits up to 1 s for
that, ~60 ms measured); failed starts are retried after 2, 4, 8, 16 s and given up after 5, and
`status()` says so instead of claiming SIGKILL coverage.

The daemon can also be run in the foreground with `bunx bun-spawn-cleanup daemon` (see the
[CLI](../README.md#cli)).

### Sweep

At the next use: every owner's first `spawn()`, and `bunx bun-spawn-cleanup sweep`, kill the
trees of ledgers whose owner is gone. This is what covers SIGKILL with the daemon off.

### killTree()

`killTree(proc)` runs the procedure scoped to that spawn (its lineage subtree and its
`-<seq>` marker), so on macOS it also reaches grandchildren that were orphaned, and still
works after the direct child exited. `killTree()` with no argument covers every lineage
member and marker carrier of this owner.

## Escapes

Items marked *tested* are asserted as escapes in the suite.

### Brokers

`launchctl submit`, ssh to localhost, cron, XPC services: created by launchd (or another
broker) with its own environment. `launchctl` is *tested*.

### Fast daemonizer with a replaced environment

A daemonizer whose intermediate forks and exits within microseconds, **combined with**
`env -i` (or any replaced environment): the lineage chain needs the intermediate's unique id
and nothing sees it alive; the marker is gone. *Tested* (without the daemon; the daemon
narrows the window but cannot close it).

### Killing the daemon

A same-user process killing the daemon. A live owner restarts it within ~2 s; until then,
and if the owner also dies by SIGKILL, cleanup waits for the next sweep. *Tested.*

### Not an escape

`setsid`, `nohup`, double fork, `detached`, reparenting to launchd, `env -i` + `setsid` (when
the process is created by a process the lineage tracking already saw), a Bun child's non-Bun
child. All *tested*.

Also not an escape: `open -n -a <app>` (LaunchServices): launchd forks the app in its own
process group, so lineage and pgid miss it, but `open` passes the caller's environment
through, so the marker catches it (*tested* with a throwaway background-only `.app`; an app
launched with a scrubbed environment would escape).

## Limits

### Best-effort

The kernel never enforces anything; see [Escapes](#escapes).

### Process-wide exit and signal coverage

The owner's lineage starts at the owner itself, so its hooks and the daemon also kill
children started with plain `Bun.spawn` or `child_process`. The env marker is only on what
went through this `spawn()`.

### Daemon process

One extra Bun process per user while any owner lives (the daemon, ~30 MB), unless
`BUN_SPAWN_CLEANUP_DARWIN_DAEMON=off`. With it off, a SIGKILLed owner's descendants live
until the next sweep.

### Worker threads

An owner that first spawns from a Worker owns only its own spawns. `worker.terminate()` runs
no cleanup in the Worker, so what it spawned lives until the **process** dies (main-thread
exit hook, which is process-wide, or the daemon / sweep after SIGKILL). If only Workers ever
call `spawn()`, a clean process exit runs no hook at all, and cleanup falls to the daemon or
the next sweep.

### Idle cost

With a daemon serving, an idle owner uses ~0.25% CPU (a liveness check every 2 s) and the
daemon a 1 s safety-net rescan; with the daemon off, the adaptive lineage tick costs ~0.25%
CPU per idle owner with no live child and ~0.45% with one (measured on an M-series Mac, ~690
processes).

### Compiled or bundled apps

With `bun build --compile` or a bundle, the daemon module is not on disk, so it is not
auto-started (the status says so); run `bunx bun-spawn-cleanup daemon` from the package
yourself if you want SIGKILL coverage. Owner hooks and the sweep work regardless.

### Restricted processes under SIP

The env marker is unreadable for `CS_RESTRICT` processes (Apple platform binaries with
restricted entitlements) when SIP is on. Lineage still covers them. Verified on a
SIP-enabled Mac with `/usr/bin/say`: marker unreadable, lineage still reports it contained.

### No forced `detached`

`spawn()` does not force `detached`: a new session per child would take the child's
controlling terminal away and break `/dev/tty` prompts in ssh, sudo, git, editors.

### Bun's NO_ORPHANS flag

Bun's `BUN_FEATURE_FLAG_NO_ORPHANS` is opt-in (`BUN_SPAWN_CLEANUP_DARWIN_NO_ORPHANS=1`): it
makes Bun children exit when their parent dies, which covers Bun subtrees without any daemon,
but a Bun process with the flag also kills its own direct children when *it* exits normally;
`Bun.spawn` does not. Both behaviors are pinned in the tests.

## Verified by the tests

The test suite asserts as contained every technique under
[Not an escape](#not-an-escape), including `open -n -a` with a throwaway background-only
`.app`, and asserts the `launchctl`, fast-daemonizer and daemon-kill cases as escapes. Both
`BUN_FEATURE_FLAG_NO_ORPHANS` behaviors are pinned. The files run with a scratch ledger
directory per file and stop their daemons afterwards (see
[Development](../README.md#development)).
