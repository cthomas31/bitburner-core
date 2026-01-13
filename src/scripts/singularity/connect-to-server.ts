/** 
 * Connects to an adjacent host.
 */
import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "host", kind: "string" }],
    run: ({ host }) => {
      const h = String(host);
      const ok = ns.singularity.connect(h) 
      return { host: h, ok: ok};
    },
  });
}
