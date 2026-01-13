/**
 * scripts/singularity/get-aug-price.ts
 *
 * Get the price of an augmentation and write to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "aug", kind: "string" }],
    run: ({ aug }) => {
      const a = String(aug);
      const price = ns.singularity.getAugmentationPrice(a);
      return { aug: a, price };
    },
  });
}
