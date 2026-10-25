/** Worker body for darwin-worker-owner.ts: spawn leaf.ts through the library, post its pid. */
import { spawn } from "../../src/index.ts";

declare const self: { onmessage: (e: MessageEvent) => void; postMessage: (v: unknown) => void };
self.onmessage = (e: MessageEvent) => {
  const { leaf, pidfile } = e.data as { leaf: string; pidfile: string };
  const p = spawn([process.execPath, leaf, pidfile], { stdio: ["ignore", "ignore", "ignore"] });
  self.postMessage(p.pid);
};
