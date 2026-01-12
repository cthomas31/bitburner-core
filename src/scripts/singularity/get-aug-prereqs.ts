/**
 * scripts/singularity/get-aug-prereqs.ts
 *
 * Get the prerequisites for an augmentation and write to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io";

export async function main(ns: NS): Promise<void> {
    const aug = String(ns.args[0] ?? "");
    const out = String(ns.args[1] ?? "data/singularity/aug-prereqs.json");

    if (!aug) {
        ns.write(out, JSON.stringify({ ts: Date.now(), ok: false, error: "missing aug" }, null, 2), "w");
        return;
    }

    const prereqs = ns.singularity.getAugmentationPrereq(aug);
    await writeJSON(ns, out, { ts: Date.now(), ok: true, aug, prereqs });
}
