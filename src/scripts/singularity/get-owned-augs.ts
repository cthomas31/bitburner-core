/**
 * scripts/singularity/get-owned-augs.ts
 *
 * Get the list of owned augmentations (installed and pending) and write to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io";

export async function main(ns: NS): Promise<void> {
    const out = String(ns.args[0] ?? "data/singularity/owned-augs.json");

    const installed = ns.singularity.getOwnedAugmentations(false);
    const owned = ns.singularity.getOwnedAugmentations(true);

    const installedSet = new Set(installed);
    const pending = owned.filter(a => !installedSet.has(a));

    await writeJSON(ns, out, { ts: Date.now(), installed, owned, pending, pendingCount: pending.length });
}
