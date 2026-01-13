/**
 * scripts/singularity/work-faction.ts
 *
 * Start working for a faction and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "factionName", kind: "string" }, { name: "workType", kind: "string" }, { name: "focuse", kind: "boolean", optional: true }],
    run: ({ factionName, workType, focus }) => {
      const fa = String(factionName);
      const w = String(workType) as "hacking" | "field" | "security";
      const fo = focus === undefined ? false : Boolean(focus);
      const ok = ns.singularity.workForFaction(fa, w, fo);
      return { factionName: fa, workType: w, focus: fo, ok };
    },
  });
}
