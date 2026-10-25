/**
 * Windows escape attempts: what the job BLOCKS and what it provably does NOT cover.
 *
 * Blocked:
 *   - CREATE_BREAKAWAY_FROM_JOB via raw CreateProcessW. The owner's job grants no breakaway
 *     permission, so the kernel refuses with ERROR_ACCESS_DENIED (5) and no process starts.
 *     The control (job disabled, owner detached from the runner's own job) shows the same
 *     call SUCCEEDING, so it is our job doing the refusing.
 *
 * Known escape (asserted as such so a behavior change is noticed):
 *   - WMI Win32_Process.Create. The process is created by WmiPrvSE.exe, a service outside the
 *     job, on the descendant's behalf. It is not a child of any job member, so it is not
 *     contained and survives the owner's death. The same holds for any out-of-job broker:
 *     Task Scheduler, UAC elevation (AppInfo), out-of-proc COM/DCOM servers, explorer.exe
 *     delegated launches. No job-based design can close this; it needs a different mechanism
 *     (and on Windows there is no unprivileged one).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  aliveAfter,
  hardKill,
  IS_WINDOWS,
  pidAlive,
  reapAll,
  sleep,
  startOwner,
  tempPidfile,
  trackLeaf,
  waitForLeaf,
} from "./helpers.ts";

const T = 60_000;
const d = IS_WINDOWS ? describe : describe.skip;

afterEach(async () => {
  await reapAll();
});

interface Breakaway {
  ok: boolean;
  err: number;
  pid?: number;
}

d("windows escapes: blocked", () => {
  test("CreateProcessW(CREATE_BREAKAWAY_FROM_JOB) is refused with ERROR_ACCESS_DENIED", async () => {
    const pidfile = tempPidfile();
    const run = await startOwner({ scenario: "breakaway", pidfile, detached: true });
    const r = JSON.parse((await run.waitFor(/^BREAKAWAY (.*)$/))[1]!) as Breakaway;
    if (r.pid) trackLeaf(r.pid); // should never happen; do not leak if it does
    expect(r.ok).toBe(false);
    expect(r.err).toBe(5);
    await run.waitFor(/^READY$/);
    await sleep(500);
    expect(await Bun.file(pidfile).exists()).toBe(false); // nothing was launched at all
  }, T);

  test("CONTROL: without our job the same breakaway call succeeds", async () => {
    const run = await startOwner({ scenario: "breakaway", pidfile: tempPidfile(), disable: true, detached: true });
    const r = JSON.parse((await run.waitFor(/^BREAKAWAY (.*)$/))[1]!) as Breakaway;
    if (r.pid) trackLeaf(r.pid);
    expect(r).toMatchObject({ ok: true, err: 0 });
    const leaf = await waitForLeaf(run);
    expect(leaf.pid).toBe(r.pid!);
    expect(pidAlive(leaf.pid)).toBe(true);
  }, T);
});

d("windows escapes: KNOWN ESCAPE (documented, not fixed)", () => {
  test("WMI Win32_Process.Create lands outside the job and survives the owner's hard kill", async () => {
    const run = await startOwner({ scenario: "wmi", pidfile: tempPidfile() });
    const wmi = await run.waitFor(/^WMI (\d+) (\d+)$/);
    trackLeaf(Number(wmi[2])); // outside every job: record it before any assertion can throw
    expect(Number(wmi[1])).toBe(0); // ReturnValue 0 == success
    const leaf = await waitForLeaf(run);
    expect(leaf.pid).toBe(Number(wmi[2]));

    // The escape, stated explicitly: not contained ...
    expect(leaf.contained).toBe(false);

    // ... and therefore not reaped.
    await hardKill(run.ownerPid);
    await sleep(1_500);
    expect(await aliveAfter(run.childPid, 1_000)).toBe(false);
    expect(pidAlive(leaf.pid)).toBe(true);
  }, T);
});
