/**
 * scripts/singularity/work-faction.ts
 *
 * Start working for a faction and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "factionName", kind: "string" }, { name: "workType", kind: "string" }],
    run: ({ factionName, workType }) => {
      const f = String(factionName);
      const w = String(workType) as "hacking" | "field" | "security";
      const ok = ns.singularity.workForFaction(f, w);
      return { factionName: f, workType: w, ok: ok };
    },
  });
}
