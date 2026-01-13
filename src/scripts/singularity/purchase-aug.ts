/**
 * scripts/singularity/purchase-aug.ts
 *
 * Purchase an augmentation from a faction and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "faction", kind: "string" }, { name: "aug", kind: "string" }],
    run: ({ faction, aug }) => {
      const f = String(faction);
      const a = String(aug);
      const ok = ns.singularity.purchaseAugmentation(f, a);
      return { faction: f, aug: a, ok: ok };
    },
  });
}
