/**
 * scripts/singularity/get-aug-stats.ts
 *
 * Get the stats/multipliers for an augmentation and write to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io.js";

export async function main(ns: NS): Promise<void> {
    const aug = String(ns.args[0] ?? "");
    const out = String(ns.args[1] ?? "data/singularity/aug-stats.json");

    if (!aug) {
        await writeJSON(ns, out, { ts: Date.now(), ok: false, error: "missing aug" });
        return;
    }

    const stats = ns.singularity.getAugmentationStats(aug);
    await writeJSON(ns, out, { ts: Date.now(), ok: true, aug, stats });
}
