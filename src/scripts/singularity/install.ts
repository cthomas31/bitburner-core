/**
 * scripts/singularity/install.ts
 *
 * Install all pending augmentations and restart with the specified bootstrap script.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io";

export async function main(ns: NS): Promise<void> {
    const bootstrap = String(ns.args[0] ?? "bootstrap.js");
    const out = String(ns.args[1] ?? "data/singularity/install.json");

    const ok = ns.singularity.installAugmentations(bootstrap);
    await writeJSON(ns, out, { ts: Date.now(), bootstrap, ok });
}
