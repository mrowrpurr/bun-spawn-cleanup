# Remaining to-dos that need a machine this project has not been run on

Everything a session could do on the machines available has been done (all three backends
implemented, reviewed, green). The items below are blocked on **host configuration**, not on
work. Each says what to run, what to look for, and what to paste back. Delete an item when
its run is recorded in `notes/`.

## 1. Linux hosts the cgroup backend has never seen

All of these take the documented fallback paths "by construction" but no run has confirmed
them. One `bun test` plus `bun test/fixtures/status-probe.ts` on each is enough; paste
`uname -r`, the status-probe JSON (`backend`, `guarantee`, `reason`) and the test summary.

- **Kernel < 6.12 (Landlock ABI < 6)**: expect `backend: linux-cgroup2+landlock`,
  `guarantee: best-effort`, reason naming missing signal scoping; `kill-supervisor` scenario
  asserts the ESCAPE variant.
- **Kernel without `TSYNC` (Landlock ABI < 8, i.e. < 6.14-ish)**: same, reason naming TSYNC.
- **Kernel < 5.13 (no Landlock)** or Landlock disabled: expect `backend: linux-cgroup2`,
  best-effort, reason naming the cgroup self-move hole.
- **Kernel < 5.14 or cgroup v1 host** (`/sys/fs/cgroup/cgroup.kill` absent): expect
  `backend: linux-best-effort` and `test/linux-cgroup.test.ts` skipped.
- **No systemd user instance** (container, minimal server, non-systemd distro): the
  transient-scope rescue (`busctl --user`) must fail cleanly into best-effort, not hang.
- **Non-Ubuntu**: Fedora / Debian 12 / Arch, any one of them, to confirm the Landlock and
  cgroup paths are not Ubuntu-specific.

## 2. Known-escape classes documented but not individually tested (optional)

Asserting these would only re-confirm a documented escape; do it if a host is handy.

- Windows: Task Scheduler (`schtasks /create` + `/run`), out-of-process COM servers, UAC
  elevation (`Start-Process -Verb RunAs`).
- Linux: `at`, `cron`, D-Bus service activation (need those daemons installed).
- macOS: XPC service activation from a descendant (needs a signed XPC bundle).

## Not blocked, deliberately not done

- Publishing to npm, and a `strict` mode that throws when containment is unavailable. Both
  were noted as possible follow-ups in `notes/2026/10/10/windows-job-object-backend.md`; no
  one has asked for them.
