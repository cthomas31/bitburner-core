/**
 * scripts/singularity/get-augs-from-faction.ts
 *
 * Get the list of augmentations available from a faction and write to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "lib/ns-io.js";

export async function main(ns: NS): Promise<void> {
    const faction = String(ns.args[0] ?? "");
    const out = String(ns.args[1] ?? "data/singularity/augs-from-faction.json");

    if (!faction) {
        ns.write(out, JSON.stringify({ ts: Date.now(), ok: false, error: "missing faction" }, null, 2), "w");
        return;
    }

    const augs = ns.singularity.getAugmentationsFromFaction(faction);
    await writeJSON(ns, out, { ts: Date.now(), ok: true, faction, augs });
}
