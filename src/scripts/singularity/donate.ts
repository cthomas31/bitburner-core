/**
 * scripts/singularity/donate.ts
 *
 * Donate money to a faction and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "faction", kind: "string" }, { name: "amount", kind: "number" }],
    run: ({ faction, amount }) => {
        const f = String(faction);
        const a = Number(amount);
      const ok = ns.singularity.donateToFaction(f, a);
      return { faction: f, amount: a, ok: ok};
    },
  });
}
