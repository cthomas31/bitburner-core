/**
 * scripts/singularity/join-faction.ts
 *
 * Join a faction and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "faction", kind: "string" }],
    run: ({ faction }) => {
      const f = String(faction);
      const ok = ns.singularity.joinFaction(f);
      return { faction: f, ok: ok };
    },
  });
}
