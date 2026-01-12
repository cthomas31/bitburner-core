/**
 * scripts/singularity/purchase-tor.ts
 *
 * Purchase the TOR router and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io.js";

export async function main(ns: NS): Promise<void> {
    const out = String(ns.args[0] ?? "data/singularity/purchase-tor.json");

    const ok = ns.singularity.purchaseTor();
    await writeJSON(ns, out, { ts: Date.now(), ok });
}
