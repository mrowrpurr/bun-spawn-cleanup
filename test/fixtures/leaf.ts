/**
 * leaf.ts <pidfile>
 *
 * The deepest process in every test tree. Writes its own pid to <pidfile> and then lives
 * forever. The test asserts on whether this pid is still alive after the owner dies.
 */
const pidfile = process.argv[2];
if (!pidfile) {
  console.error("usage: leaf.ts <pidfile>");
  process.exit(2);
}
await Bun.write(pidfile, String(process.pid));
setInterval(() => {}, 60_000);
