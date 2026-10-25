# Windows

Backend: Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Guarantee: `kernel`.

## Mechanism

Setup runs at the import line of `bun-spawn-cleanup`, or at `configureSpawnCleanup()` from
`bun-spawn-cleanup/core` (see the [README](../README.md#core-you-pick-the-moment)).

### Kill-on-close Job Object

1. At setup, create an unnamed Job Object, set `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and
   assign **the current process** to it.
2. Every process spawned afterwards, and every process those spawn, inherits membership.
   There is no per-child race: children are in the job from their first instruction.
3. The only handle to the job is held in memory and never closed. Process death closes it,
   and closing the last handle to a kill-on-close job terminates every member.
4. No breakaway flags are granted, so `CREATE_BREAKAWAY_FROM_JOB` is refused to descendants
   (`ERROR_ACCESS_DENIED`). There is no opt-out: if a descendant must outlive you, do not
   start it through a process that uses this library.

### Nested jobs for killTree()

1. Each `spawn()`ed child is also assigned to its own empty **nested** job, which is what
   `killTree()` terminates. Nested jobs carry no kill-on-close limit, so a grandchild that
   outlives its parent still dies with the owner, not with its parent. The nested job is
   kept while anything in it is alive, so `killTree()` still reaches daemonized
   grandchildren after the direct child has exited.

`killTree()` with no argument terminates the owner's own job minus the owner, which also
catches grandchildren that slipped out of a child's nested job in the microseconds before
tracking attached.

## Escapes

A process that a **service outside the job** creates on a descendant's behalf is not a child
of any job member and is not reaped. Items marked *tested* are asserted as escapes in the
suite.

### Service brokers

- WMI `Win32_Process.Create` (`Invoke-CimMethod`, `wmic process call create`): created by
  `WmiPrvSE.exe`. Any standard user, no prompt. *Tested.*
- Task Scheduler (`schtasks /create` + `/run`): created by the Schedule service. Any user.
  Not individually tested.
- UAC elevation (`Start-Process -Verb RunAs`, `ShellExecute("runas")`): created by the
  AppInfo service. Prompts by default; silent if UAC is set to "never notify". Not
  individually tested.
- Out-of-process COM/DCOM servers (`Excel.Application`, `Word.Application`, any server
  registered to run in its own process): created by DcomLaunch. A script automating Office
  that is killed leaves Office running. Not individually tested.
- `explorer.exe`-delegated launches. Not individually tested.
- Packaged-app activation (`wt.exe`, Store apps, app execution aliases,
  `shell:AppsFolder`): created by the activation broker. Not individually tested.
- `runas /user:`, WinRM to localhost, `psexec`: service-launched; need credentials or admin. Not
  individually tested.

No job-based design closes these. The only closures (restricted tokens, Low integrity, a
dedicated account) restrict what the workload can access, which this library does not do.

### Not an escape

`detached`, `start /b`, `Start-Process`, `DETACHED_PROCESS`, `CREATE_NEW_CONSOLE`, orphaned
grandchildren, `CREATE_BREAKAWAY_FROM_JOB` (refused with `ERROR_ACCESS_DENIED`). All
*tested*.

## Limits

### Process-wide containment

Containment is process-wide, not per `spawn()` call. From setup on, everything the Bun
process starts by any API (`Bun.spawn`, `node:child_process`, FFI) is in the job and dies
with you. A descendant that asks for `CREATE_BREAKAWAY_FROM_JOB` (some browsers, updaters,
installers) gets `ERROR_ACCESS_DENIED`.

### Host already inside a job

Works when the host is already inside another job (nested jobs, Windows 8+). If the outer
job forbids nesting, `status()` reports `active: false` with the Win32 error and `spawn`
degrades to a plain `Bun.spawn`. Check the status if you need to know.

### killTree() timing

Grandchildren a child starts in the microseconds between `Bun.spawn` returning and the
nested-job assignment are missed by `killTree()` but still die with the owner.

### Options

Windows has no knobs beyond `disable` (see
[Options and environment knobs](../README.md#options-and-environment-knobs)).

## Verified by the tests

The test suite (`bun test`) hard-kills an owner process with `taskkill /F /PID` (no `/T`)
and checks that a leaf launched via `Bun.spawn`, `Bun.spawn({ detached: true })`,
`cmd /c start /b`, and PowerShell `Start-Process` is dead within seconds. Control runs with
the job disabled show those same leaves surviving.
