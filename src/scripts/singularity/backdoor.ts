/** 
 * Attempts to install a backdoor on the current host.
 */
import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [],
    run: async () => {
      await ns.singularity.installBackdoor();
      return {};
    },
  });
}
