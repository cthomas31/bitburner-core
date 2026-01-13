/**
 *
 * Get the list of owned augmentations (installed and pending) and write to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "purchased", kind: "boolean" }],
    run: ({ purchased }) => {
      const p = Boolean(purchased);
      const augs = ns.singularity.getOwnedAugmentations(p);
      return { purchased: p, augs: augs };
    },
  });
}
