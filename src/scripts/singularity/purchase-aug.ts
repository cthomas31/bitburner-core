/**
 * scripts/singularity/purchase-aug.ts
 *
 * Purchase an augmentation from a faction and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io.js";

export async function main(ns: NS): Promise<void> {
    const faction = String(ns.args[0] ?? "");
    const aug = String(ns.args[1] ?? "");
    const out = String(ns.args[2] ?? "data/singularity/purchase-aug.json");

    if (!faction || !aug) {
        ns.write(out, JSON.stringify({ ts: Date.now(), ok: false, error: "missing faction/aug" }, null, 2), "w");
        return;
    }

    const ok = ns.singularity.purchaseAugmentation(faction, aug);
    await writeJSON(ns, out, { ts: Date.now(), faction, aug, ok });
}
