/**
 * scripts/singularity/get-aug-prereqs.ts
 *
 * Get the prerequisites for an augmentation and write to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "aug", kind: "string" }],
    run: ({ aug }) => {
      const a = String(aug);
      const prereqs = ns.singularity.getAugmentationPrereq(a);
      return { aug: a, prereqs };
    },
  });
}
