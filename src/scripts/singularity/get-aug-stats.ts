/** 
 * Gets the stats of a specified augmentation.
 */
import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "aug", kind: "string" }],
    run: ({ aug }) => {
      const a = String(aug);
      const stats = ns.singularity.getAugmentationStats(a);
      return { aug: a, stats };
    },
  });
}
