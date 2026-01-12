/**
 * scripts/singularity/donate.ts
 *
 * Donate money to a faction and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io";

export async function main(ns: NS): Promise<void> {
    const faction = String(ns.args[0] ?? "");
    const amount = Number(ns.args[1] ?? 0);
    const out = String(ns.args[2] ?? "data/singularity/donate.json");

    const ok = ns.singularity.donateToFaction(faction, amount);
    await writeJSON(ns, out, { ts: Date.now(), faction, amount, ok });
}
