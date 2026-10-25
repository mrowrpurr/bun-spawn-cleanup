# Linux

Backends: `linux-cgroup2+landlock` (guarantee `kernel` on Landlock ABI 8+, else
`best-effort`) and `linux-best-effort` (guarantee `best-effort`).

## Mechanism

Two mechanisms, picked automatically at setup (the import line of `bun-spawn-cleanup`, or
`configureSpawnCleanup()` from `bun-spawn-cleanup/core`) and reported by `status().backend`.

### linux-cgroup2+landlock

1. Read the cgroup this process is in (`/proc/self/cgroup`) and create a child cgroup under
   it. Systemd delegates the whole `user@<uid>.service` tree to the user, so this works
   unprivileged inside any user service, `systemd-run --user --scope`, or desktop app.
   If the current cgroup is not writable (a plain login session's scope is root-owned), ask
   the user's systemd instance over D-Bus to move this process into a transient scope, which
   is user-owned, and create the child cgroup there.
2. Start a detached `/bin/sh` supervisor whose stdin is a pipe only this process holds, then
   move **this process** into the new cgroup. Everything spawned from now on, by any API,
   is born inside it. `setsid`, `nohup`, double fork, `disown`, `env -i` and reparenting do
   not change cgroup membership.
3. Apply a **Landlock** ruleset (kernel 5.13+, on by default in Ubuntu, Fedora, Debian 12,
   Arch): deny every write under `/sys/fs/cgroup`, allow them everywhere else, and on
   kernel 6.12+ forbid signals to any process outside the sandbox. Landlock is inherited by
   every descendant and cannot be removed, so a descendant that writes its pid into another
   `cgroup.procs` gets `EACCES`, and one that tries to `kill -9` the supervisor gets
   `EPERM`. Both attempts are tested, with Landlock-off controls showing the same code
   succeeding.
4. When this process dies by any means, the pipe hits EOF and the supervisor writes `1` to
   `cgroup.kill`: the kernel SIGKILLs every process in the subtree atomically, including
   ones forked concurrently. The supervisor then removes the cgroup directories and exits.
   A second, independent detector (a subshell) polls `/proc/<owner>/stat` once a second
   (pid plus start time, zombie counts as dead), so cleanup depends neither on the pipe nor
   on the main supervisor shell: stopping that shell and killing the owner still reaps the
   tree (tested). The pipe is a socketpair, which cannot be reopened through
   `/proc/<pid>/fd` (tested). The poller's only per-second cost is one `sleep 1`.
   The supervisor's configuration travels over the pipe, not argv: its command line is
   `bsc-supervisor <token>` and contains neither `bun`, the package name, nor your cgroup
   path or unit name (tested), so a `pkill -f` aimed at the owner cannot match it.
5. Each `spawn()`ed child is moved into its own nested cgroup (by the supervisor, on
   command, since the owner can no longer write cgroupfs itself), which is what `killTree()`
   targets. It is kept while anything in it is alive, so `killTree()` still reaches
   daemonized grandchildren after the direct child has exited. `killTree()` with no argument
   targets the owner's own cgroup minus the owner, which also catches grandchildren that
   slipped out of a child's nested cgroup in the microseconds before tracking attached.

`guarantee: "kernel"` is reported only when all three Landlock features are in force:
filesystem rules (ABI 1+), signal scoping (ABI 6+, kernel 6.12) and `TSYNC` (ABI 8), which
applies the ruleset to every thread. Together they stop a deliberate same-UID descendant,
including a child of a Worker that existed before setup, from leaving the cgroup or killing
the supervisor. With anything less the cgroup still catches every ordinary escape, but the
backend reports `guarantee: "best-effort"` and a `reason` naming the hole.

### linux-best-effort

Used when no writable cgroup v2 exists, or when forced with
`BUN_SPAWN_CLEANUP_LINUX_MECHANISM=best-effort`.

Process-wide, like the other backends: it covers everything this process starts by any API,
however it double-forks, and `spawn()` is byte-for-byte `Bun.spawn` (no env injection).

1. At setup the owner calls `prctl(PR_SET_CHILD_SUBREAPER, 1)` (kernel 3.4+, no privilege).
   Every orphaned descendant then reparents to the owner instead of init, so the whole tree
   stays reachable from the owner's pid through `/proc/<pid>/stat` parent links. Pre-existing
   descendants are already reachable the same way, so adoption is free here.
2. A detached `/bin/sh` supervisor holds the other end of a pipe. While the owner lives it
   snapshots the owner's descendant set once a second from `/proc`, and the owner streams it
   every new direct child within 50 ms (`/proc/self/task/*/children`), because an orphan that
   just became a direct child is exactly what reparents to init the instant the owner dies.
   On pipe EOF it SIGSTOPs the recorded set and their live descendants until the set is
   stable, SIGKILLs them all, then rescans `/proc/*/environ` for the owner's
   `BUN_SPAWN_CLEANUP_ID` marker as a second net (the owner stamps its own `process.env`, so
   children spawned with `{ ...process.env }` carry it).
3. `killTree(proc)` freezes then SIGKILLs the child, the descendants recorded for it, and
   their current descendants; it works after the child itself exited. `killTree()` with no
   argument does the same for every descendant of the owner.
4. The owner reaps the zombies of adopted orphans (Bun only waits for what it spawned).

If `prctl` fails, `spawn()` falls back to injecting the marker (the one case it is not
byte-for-byte `Bun.spawn`) and `status().reason` says so.

### Nested owners

A nested owner (a descendant that also uses this library) detects the outer owner's cgroup,
creates none of its own, never leaves it, and runs the best-effort (subreaper) mechanism
inside the outer kernel containment: its own `killTree()` and death-reaping work on its own
subtree, and the outer owner's `cgroup.kill` still takes everything, nested owners included,
when the outer owner dies. Its `status()` says `backend: "linux-best-effort"` with a reason
starting `nested inside another bun-spawn-cleanup owner's cgroup`.

### Why not a PID namespace

`unshare(CLONE_NEWUSER)` fails with `EINVAL` in a multithreaded process, and Bun is
multithreaded, so the unprivileged route is impossible from inside the owner.
`unshare(CLONE_NEWPID)` alone needs `CAP_SYS_ADMIN`, and a root caller has cgroup v2.

## Escapes

Everything below is a process that a **service outside the tree** creates on a descendant's
behalf, unless stated otherwise. Items marked *tested* are asserted as escapes in the suite.

### Brokers

- `systemd-run --user` transient service: forked by the user's systemd (the user manager
  forks the service). *Tested.*
- `systemd-run --user --scope`: systemd places it in a new cgroup. *Tested.*
- `at`, `cron`, D-Bus service activation: same shape, not individually tested.

Same shape as WMI on Windows; no unprivileged mechanism on any OS closes IPC to a daemon that
spawns processes.

### Killing the supervisor

Not a broker. An unrelated process of the same user can kill both supervisor processes (for
example `pkill sh` from your terminal). Descendants cannot do this on kernel 6.12+ (Landlock
signal scoping). `pkill -f bun` spares the supervisor (nothing in its command line matches).
When the supervisor dies while the owner lives, the owner **restarts it** (same recipe as
setup; at most 5 restarts per 60 s, then `status()` reports `active: false` with the
reason). A landlocked owner can only start a replacement inside its own sandbox and cgroup,
which cannot write `cgroup.kill`: it kills by signal instead, so after such a restart
`status()` stays `active: true` with `guarantee: "best-effort"` and a reason saying so, and
new spawns get no per-spawn cgroup. If the old poller survived it still does the real
`cgroup.kill` on owner death.

### A dead owner's cgroup

If both supervisor processes were gone when the owner died, its `bsc-<pid>-<hex>` cgroup and
tree survive. Every later setup on the host **sweeps** sibling owner cgroups whose owner pid
is dead (or was recycled: start time newer than the directory), writing `cgroup.kill` and
removing the directory; `bun-spawn-cleanup sweep` does the same on demand (see the
[CLI](../README.md#cli)).

### Without Landlock

With `BUN_SPAWN_CLEANUP_LINUX_LANDLOCK=0`, or on kernels without Landlock: a descendant can
write its own pid into another `cgroup.procs` and leave. *Tested* with Landlock off.

### Best-effort mode

With no writable cgroup (`linux-best-effort`), additionally:

- `env -i` or any spawn with a replaced environment, since the marker is gone. *Tested.*
- A descendant that calls `setsid` AND an unrelated process kills the supervisor. Asserted
  in the tests.

### Not an escape

`setsid`, `nohup`, double fork, `disown`, `env -i`, reparenting, cgroup self-move (with
Landlock). All *tested*.

## Limits

### Process-wide containment

Containment is process-wide in cgroup mode, exactly as on Windows: after the first
`spawn()`, everything the process starts by any API dies with it.

### Landlock side effects

Landlock implies `no_new_privs`: setuid programs (`sudo`, `su`, `snap`, `mount`) run by the
owner or any descendant no longer gain privileges. On kernel 6.12+ the owner and its
descendants also get `EPERM` from `process.kill()` on anything outside the tree: children
started before setup, the owner's own parent, unrelated processes. Set
`BUN_SPAWN_CLEANUP_LINUX_LANDLOCK=0` (or `configureSpawnCleanup({ linux: { landlock: false }
})` via `/core`) if you need either; the guarantee then drops to best-effort and the status
reason says why.

The Landlock allow-list is a snapshot of the top-level directories at setup: a directory
created later directly under `/`, `/sys` or `/sys/fs` is unwritable for the tree. Only the
cgroup2 mount listed in `/proc/self/mountinfo` is denied, not a second bind mount of it.

### The owner changes cgroup

In cgroup mode the owner process **changes cgroup**. Inside a delegated tree it moves one
level down. In a plain login session it moves from the session scope
into a transient scope under `app.slice`, which is where `systemd-run --user` would have put
it.

### Requirements for cgroup mode

Requires cgroup v2 with `cgroup.kill` (kernel 5.14+) and a user-writable cgroup. Not
available: non-root in most containers, hosts without a systemd user instance, cgroup v1
hosts. Then the backend falls back to best-effort and says so in `status().reason`.
`status()` tells you which mechanism you got; check it if the `kernel` guarantee matters to
you.

### Best-effort latency

In `linux-best-effort`, attribution of a non-library orphan has up to about 50 ms of latency
(asserted in the tests).

## Verified by the tests

The test suite SIGKILLs an owner and checks that a leaf launched via `Bun.spawn`,
`Bun.spawn({ detached: true })`, `setsid`, `sh -c 'nohup ... &'`, a double fork, bash
`& disown`, `env -i`, a cgroup self-move attempt, and a supervisor-kill attempt is dead
within seconds, and that the cgroup directory is gone. Control runs with cleanup disabled
show those same leaves surviving.

The Landlock tests run the cgroup self-move (`EACCES`) and supervisor-kill (`EPERM`) attempts
again with Landlock off and show the same code succeeding. The `linux-best-effort` escapes
and limits above are asserted in the tests. See
[Development](../README.md#development) for which Linux test files need a writable cgroup
or a user systemd instance.
