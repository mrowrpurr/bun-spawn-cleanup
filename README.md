# bun-spawn-cleanup

Bun.spawn that leaves no orphans.

## Why

On Windows, Linux and macOS, a parent process exiting does not end its children: they keep
running, reparented or detached. Process groups do not hold a tree together: on Linux and
macOS a descendant leaves its group with `setsid`; on Windows a child started with `start /b`
or `Start-Process` is never in it. Signal and exit handlers that kill children on the way out
never run when the parent dies by SIGKILL, `taskkill /F` or an OOM kill. Children and
grandchildren therefore outlive the process that started them.

## What

A `Bun.spawn` drop-in that reaps every process you spawn, and everything *they* spawn,
when your process exits or is killed, by any means.

On Windows and Linux (with a writable cgroup): **every process created by your tree, by
any API, however it detaches, dies when you die.** `detached`, `start /b`, `setsid`,
`nohup`, double-fork, `Start-Process`, a parent exiting before its child, an explicit
breakaway request: all contained, with no cooperation from anyone, and the test suite
proves each one against a control that leaks when the mechanism is off. Ctrl-C, `kill -9`,
`taskkill /F`, `Stop-Process -Force`, a crash, an OOM kill: all reap the tree.

**Importing `bun-spawn-cleanup` changes your process.** The import line is the setup: on
Windows your process joins a kill-on-close Job Object; on Linux it moves into its own cgroup,
starts a detached supervisor and applies a Landlock ruleset, after which nothing in your tree
can run `sudo` (or any setuid program) and, on kernels 6.12+, nothing in your tree can signal
a process outside it. From that line on, every process your process creates, by any API, dies
with it. It cannot be undone. If you would rather decide when (or whether) that happens, or
pass options, import `bun-spawn-cleanup/core` and call `configureSpawnCleanup()` yourself;
importing `/core` does nothing to your process.

| Platform | Condition | Backend | Guarantee | Details |
| --- | --- | --- | --- | --- |
| Windows | | Job Object, `KILL_ON_JOB_CLOSE` | **kernel** | [docs/windows.md](docs/windows.md) |
| Linux | cgroup v2, Landlock ABI 8+ (signal scoping + `TSYNC`) | cgroup v2 + `cgroup.kill` + Landlock, detached supervisor | **kernel** | [docs/linux.md](docs/linux.md) |
| Linux | cgroup v2, older or no Landlock | same, minus (part of) the sandbox | best-effort | [docs/linux.md](docs/linux.md) |
| Linux | no writable cgroup | inherited env marker + `/proc` scan | best-effort | [docs/linux.md](docs/linux.md) |
| macOS | | kernel lineage ids + env marker + ledger; owner exit/signal hooks; auto-started kqueue daemon for SIGKILL | best-effort (no unprivileged kernel mechanism exists) | [docs/darwin.md](docs/darwin.md) |

The condition is detected at setup and reported by `status().backend`.

## Install

`bun add bun-spawn-cleanup`. Bun only (uses `bun:ffi`). Requires Bun >= 1.3.0.

## Usage

### Import and forget

```ts
import { spawn, killTree } from "bun-spawn-cleanup";

// Same overloads and return type as Bun.spawn.
const proc = spawn(["cmd", "/c", "start", "/b", "some-daemon.exe"], { stdout: "pipe" });

// Optional: kill just that subtree now (child + grandchildren), owner keeps running.
killTree(proc);

// Optional: kill EVERY descendant of this process, now; this process keeps running.
killTree();
```

Nothing else to do. Containment is in place from the import line (static imports are
hoisted, so before any of your own code runs). When your process dies (clean exit, uncaught
throw, `taskkill /F`, `Stop-Process -Force`, `kill -9`, OOM kill, crash), the whole tree is
killed.

### `/core`: you pick the moment

```ts
import { configureSpawnCleanup, spawn, status } from "bun-spawn-cleanup/core";

if (!argv.includes("--no-cleanup")) {
  configureSpawnCleanup({ linux: { landlock: false } }); // this tree needs sudo
}
console.error(status()); // { platform, backend, guarantee, active, reason? }
const proc = spawn(["git", "status"]);
```

`bun-spawn-cleanup/core` exports the same API. Importing it has no side effect.
`configureSpawnCleanup(options?)` is the setup: call it once, where the program chooses, after
any runtime decision. It is irreversible (a process cannot leave a Windows job, and Landlock
forbids leaving the cgroup), so there is no `stop()`. Options mirror the
[environment knobs](#options-and-environment-knobs) and win over them when both are set.
Setup also **adopts the descendants you already have**: whatever the platform can enumerate
under your pid at that moment (toolhelp snapshot on Windows, `/proc` parent links on Linux,
child pids and lineage ids on macOS) is assigned into the job / cgroup / ledger, so "spawned
before setup" stops mattering wherever the platform can make it stop mattering. Best-effort: a
descendant that already daemonized out of the parent chain is missed. With the root entry the
question never arises, since nothing exists before the import line. `/core` is for CLIs with a
`--no-cleanup` flag, programs that need `sudo` in their tree, and anything that wants options
rather than env vars.

The rules are enforced by throwing:

| Situation | Result |
| --- | --- |
| `/core` `spawn()` before `configureSpawnCleanup()` | throws |
| `configureSpawnCleanup()` called twice | second call throws |
| root imported anywhere in the graph, then `/core` `configureSpawnCleanup()` | throws, saying the root import did it |
| `configureSpawnCleanup()` from `/core`, then an `import("bun-spawn-cleanup")` | the import rejects |
| root imported twice (duplicate copy in `node_modules`, `bun --hot` reload) | fine, one setup |

The configured flag lives on `globalThis` under `Symbol.for("bun-spawn-cleanup/configured")`,
so duplicate copies share it. It is per JS realm: a `Worker` has its own, so a Worker that
imports the root configures again (a second, nested containment of the same process on
Windows and Linux, which is redundant) and a Worker on `/core` must call
`configureSpawnCleanup()` itself before `spawn()`. Prefer spawning from the main thread.
`killTree()` and `status()` work before configure (`status()` reports `active: false, reason:
"not configured ..."`; `killTree()` falls back to `kill()`); neither configures the process as
a side effect.

### Killing a subtree early

- `killTree(proc | pid): KillTreeResult` terminates that subtree, now, while you keep running;
  it works after the direct child itself exited. It falls back to `proc.kill()` when the
  child is untracked (`tracked: false`). Repeatable: spawn, kill, spawn, kill, each child gets
  its own nested job / cgroup.
- `killTree()` with no argument terminates every descendant of this process and leaves this
  process alive. On Windows and Linux/cgroup that is the owner's own job / cgroup minus the
  owner, which also catches grandchildren that slipped out of a child's nested group in the
  microseconds before tracking attached. On macOS it is every lineage member and marker
  carrier of this owner.

### Checking what you got

`status(): CleanupStatus` is read-only: `{ platform, backend, guarantee, active, reason? }`.
It is correct from the moment setup ran, and reports `active: false, reason: "not configured
..."` before. `backend` names the mechanism in use and `guarantee` is `kernel` or
`best-effort`, as in the table above.

### CLI

`bunx bun-spawn-cleanup <command>` on macOS and Linux (Windows prints "not needed on this
platform"):

- `daemon [--once]`: run the daemon in the foreground (exits 0 if one is already serving;
  `--once` sweeps and exits). Run it from your own LaunchAgent if you prefer that to
  auto-start.
- `sweep`: kill the trees of ledgers whose owner is gone; prints what died.
- `status`: ledger directory, daemon pid, live and stale owners.
- `ls`: every process carrying a marker, grouped by owner.

On Linux the cgroup directory is the source of truth (`cgroup.procs` lists every survivor
exactly): `sweep` kills and removes every `bsc-<pid>-<hex>` owner cgroup under the cgroup2
root whose owner is gone, and kills best-effort marker carriers whose owner pid is gone;
`status` lists each owner cgroup with its pid, alive/GONE, member count and path, plus marker
owners; `ls` lists every owner cgroup's members (`pid comm`) and marker carriers grouped by
owner. `daemon` is macOS only.

## How it works

Every process the owner creates is tagged (job membership, cgroup membership, or lineage ids
plus an env marker), and the tag is acted on when the owner dies: by the kernel, by a
supervisor or daemon that outlives the owner, or by the owner's own exit and signal hooks.

- **Windows**: the owner joins a kill-on-close Job Object and every descendant inherits job
  membership. Process death closes the last handle to the job, and the kernel terminates
  every member.
- **Linux, cgroup**: the owner moves into its own cgroup and every descendant is born inside
  it. When the owner dies, a detached supervisor writes `1` to `cgroup.kill` and the kernel
  SIGKILLs every process in the subtree. Landlock stops descendants from leaving the cgroup
  or killing the supervisor.
- **Linux, no writable cgroup**: the owner becomes a child subreaper and stamps an env marker;
  a detached supervisor kills the descendants it recorded and the marker carriers.
- **macOS**: every process is tagged by kernel lineage ids, an env marker and (for `detached`
  spawns) its process group, written to a ledger. The owner's exit and signal hooks, a kqueue
  daemon, or the next sweep kills the tagged processes.

`kernel` in the table means the kernel enforces both membership and the kill, and no
descendant can leave the group or stop the killer. `best-effort` means ordinary detaching
(`setsid`, `nohup`, double fork, reparenting) is caught, but a same-user process can leave the
group or kill the process that does the killing.

One escape class is common to every OS: a descendant that asks a **system service** to create
a process on its behalf (WMI `Win32_Process.Create` or Task Scheduler on Windows,
`systemd-run` as a transient service or `at` on Linux, `launchctl` on macOS). That process
was created by the service, not by your tree, and no ancestry-based mechanism can see it.
Closing it means restricting what the workload may access (restricted tokens, Landlock
policy, a dedicated account), which this library does not do: your processes can do anything
they like, they cannot outlive you. The test suite asserts WMI, both `systemd-run` forms and
`launchctl` as escapes.

Details per platform: [docs/windows.md](docs/windows.md), [docs/linux.md](docs/linux.md),
[docs/darwin.md](docs/darwin.md).

## Options and environment knobs

Every knob is both a `configureSpawnCleanup()` option (`/core` only) and an env var. Both
are read once, at setup; the option wins when both are set. Env stays for out-of-process
configuration (a wrapper script, CI) and for tests. Windows has no knobs beyond `disable`.

| Option | Env | Meaning |
| --- | --- | --- |
| `disable: true` | `BUN_SPAWN_CLEANUP_DISABLE=1` | skip containment everywhere; `status()` reports `active: false` with that reason. Exists so tests can prove the mechanism is load-bearing. |
| `linux.mechanism: "auto" \| "cgroup" \| "best-effort"` | `BUN_SPAWN_CLEANUP_LINUX_MECHANISM` | pin a mechanism. `cgroup` reports `active: false` instead of falling back when cgroups are unusable. |
| `linux.landlock: false` | `BUN_SPAWN_CLEANUP_LINUX_LANDLOCK=0` | keep the cgroup but skip Landlock. |
| `darwin.daemon: "auto" \| "off"` | `BUN_SPAWN_CLEANUP_DARWIN_DAEMON` | default `auto`: whether setup starts the daemon. |
| `darwin.ledgerDir` | `BUN_SPAWN_CLEANUP_DIR` | ledger directory, default `$TMPDIR/bun-spawn-cleanup`. Owners and daemons only see each other within one directory. |
| `darwin.lineageMs` | `BUN_SPAWN_CLEANUP_DARWIN_LINEAGE_MS` | default 250, `0` off: owner-side lineage snapshot interval. The same timer restarts a killed daemon. |
| `darwin.noOrphans: true` | `BUN_SPAWN_CLEANUP_DARWIN_NO_ORPHANS=1` | also set Bun's NO_ORPHANS flag on every spawn (see the macOS limits). |
| (tests only) | `BSC_TEST_DAEMON_IDLE_MS=<ms>` | macOS: idle time of daemons an owner starts (default 60 s). |
| (tests only) | `BSC_TEST_DAEMON_FAIL=<file>` | macOS: the daemon appends its pid to the file and fails at startup, to test the owner's backoff. |
| (tests only) | `BSC_TEST_REQUIRE_CGROUP=1` | make the cgroup suite fail instead of skipping on a host without cgroup access, so CI cannot pass having tested nothing. |

## API

Root (`bun-spawn-cleanup`, configures at import) and `/core` (configure yourself) export the
same three functions:

- `spawn(...)`: identical signature to `Bun.spawn`.
- `killTree(proc | pid): KillTreeResult`, and `killTree()` with no argument: see
  [Killing a subtree early](#killing-a-subtree-early).
- `status(): CleanupStatus`: see [Checking what you got](#checking-what-you-got).

`/core` adds `configureSpawnCleanup(options?: CleanupOptions): CleanupStatus`.

`bun-spawn-cleanup/internal` (no side effect, unsupported, for this library's tests and for
debugging a backend): `backend`, `isContained(pid)`, `isConfigured()`, `configuredBy()`,
`DISABLE_ENV`.

## Development

```
bun install
bun test            # platform suites skip themselves elsewhere
bun run typecheck
```

On Linux, `test/linux-cgroup.test.ts` skips itself (and says so) when the host gives the
library no writable cgroup v2; `test/linux-best-effort.test.ts` and
`test/linux-controls.test.ts` run on any Linux. The `systemd-run` escape tests need a
reachable user systemd instance.

On macOS, `test/darwin-*.test.ts` run with a scratch ledger directory per file and stop
their daemons afterwards; `test/preload.ts` (via `bunfig.toml`) points every other test at
a scratch directory too, so a test run never touches your real ledgers.

Publishing to npm uses a token, read from the `NPM_TOKEN` environment variable by the
project's `.npmrc`:

```
bun publish --dry-run      # lists the tarball contents, publishes nothing
NPM_TOKEN=<token> bun publish          # bash / zsh
$env:NPM_TOKEN="<token>"; bun publish  # PowerShell
```

The tarball is the `files` list in `package.json`: `src`, `bin`, `docs`, `README.md`,
`LICENSE`, `LICENSE-0BSD`. `prepublishOnly` runs the typecheck first.

Platform backends live in `src/platform/<platform>/index.ts` and implement the
`CleanupBackend` interface in `src/backend.ts`. `src/state.ts` holds the process-wide
backend and configured flag; `src/core.ts` is the public API over it; `src/index.ts` is
`core` plus the configure-at-import side effect. Backends never do anything at import. Tests
use fixtures in `test/fixtures/`: `owner.ts` (uses the library) spawns `child.ts`, which runs
one escape scenario from `test/fixtures/scenarios/<platform>.ts` to launch `leaf.ts` (writes
its pid, lives forever). The `bun test` runner itself never calls the library, since that
would put the runner in a job or cgroup for the rest of the run.

Platform documentation (mechanism, escapes, limits, what the tests verify) lives in
`docs/<platform>.md`.

## License

This software is available under either the [MIT License](LICENSE)
or the [BSD Zero Clause License (0BSD)](LICENSE-0BSD),
at your option.
