/**
 * scripts/singularity/join-faction.ts
 *
 * Join a faction and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io";

export async function main(ns: NS): Promise<void> {
    const faction = String(ns.args[0] ?? "");
    const out = String(ns.args[1] ?? "data/singularity/join-faction.json");

    if (!faction) {
        ns.write(out, JSON.stringify({ ts: Date.now(), ok: false, error: "missing faction" }, null, 2), "w");
        return;
    }

    const ok = ns.singularity.joinFaction(faction);
    await writeJSON(ns, out, { ts: Date.now(), faction, ok });
}
