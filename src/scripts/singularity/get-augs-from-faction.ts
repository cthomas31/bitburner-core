/**
 * scripts/singularity/get-augs-from-faction.ts
 *
 * Get the list of augmentations available from a faction and write to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "faction", kind: "string" }],
    run: ({ faction }) => {
      const f = String(faction);
      const augs = ns.singularity.getAugmentationsFromFaction(f);
      return { faction: f, augs: augs };
    },
  });
}
