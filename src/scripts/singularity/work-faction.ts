/**
 * scripts/singularity/work-faction.ts
 *
 * Start working for a faction and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io";

type FactionWorkType = "hacking" | "field" | "security";

export async function main(ns: NS): Promise<void> {
    const faction = String(ns.args[0] ?? "");
    const workType = String(ns.args[1] ?? "hacking") as FactionWorkType; // hacking | field | security
    const focus = Boolean(ns.args[2] ?? false);
    const out = String(ns.args[3] ?? "data/singularity/work-faction.json");

    const ok = ns.singularity.workForFaction(faction, workType, focus);
    await writeJSON(ns, out, { ts: Date.now(), faction, workType, focus, ok });
}
