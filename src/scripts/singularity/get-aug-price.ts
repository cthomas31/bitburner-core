/**
 * scripts/singularity/get-aug-price.ts
 *
 * Get the price of an augmentation and write to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "lib/ns-io.js";

export async function main(ns: NS): Promise<void> {
    const aug = String(ns.args[0] ?? "");
    const out = String(ns.args[1] ?? "data/singularity/aug-price.json");

    if (!aug) {
        await writeJSON(ns, out, { ts: Date.now(), ok: false, error: "missing aug" });
        return;
    }

    const price = ns.singularity.getAugmentationPrice(aug);
    await writeJSON(ns, out, { ts: Date.now(), ok: true, aug, price });
}
