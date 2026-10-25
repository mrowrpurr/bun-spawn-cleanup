/**
 * scope-probe.ts
 *
 * Exercises `moveSelfToTransientScope` directly, in its own process: asks the user's
 * systemd instance to move THIS pid into a transient scope, then checks that the new cgroup
 * is user-writable (mkdir + rmdir of a child cgroup). Prints one JSON line. On hosts whose
 * cgroup is already writable in place, auto-detection never takes this path, so this is the
 * only coverage it gets there.
 */
import { makeCgroup, moveSelfToTransientScope, removeCgroup } from "../../src/platform/linux/cgroup.ts";
import { cgroupPathOf } from "../../src/platform/linux/proc.ts";

const before = cgroupPathOf("self");
const unit = `bsc-probe-${process.pid}.scope`;
const moved = moveSelfToTransientScope(process.pid, unit);
const after = cgroupPathOf("self");
let writable = false;
if ("path" in moved) {
  const dir = `/sys/fs/cgroup${moved.path}/probe`;
  writable = makeCgroup(dir) === undefined;
  if (writable) removeCgroup(dir);
}
console.log(JSON.stringify({ before, after, unit, moved, writable }));
