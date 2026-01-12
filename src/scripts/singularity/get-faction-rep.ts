/**
 * scripts/singularity/get-faction-rep.ts
 *
 * Get the current reputation with a faction and write to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io";

export async function main(ns: NS): Promise<void> {
    const faction = String(ns.args[0] ?? "");
    const out = String(ns.args[1] ?? "data/singularity/get-faction-rep.json");

    const rep = ns.singularity.getFactionRep(faction);
    await writeJSON(ns, out, { ts: Date.now(), faction, rep });
}
