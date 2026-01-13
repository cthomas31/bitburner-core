/**
 * scripts/singularity/get-faction-rep.ts
 *
 * Get the current reputation with a faction and write to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "faction", kind: "string" }],
    run: ({ faction }) => {
      const f = String(faction);
      const rep = ns.singularity.getFactionRep(f);
      return { faction: f, rep };
    },
  });
}