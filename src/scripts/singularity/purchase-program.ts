/**
 * scripts/singularity/purchase-program.ts
 *
 * Purchase a program from the darkweb and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io.js";

export async function main(ns: NS): Promise<void> {
    const program = String(ns.args[0] ?? "");
    const out = String(ns.args[1] ?? "data/singularity/purchase-program.json");

    const ok = ns.hasTorRouter() && ns.singularity.purchaseProgram(program);
    await writeJSON(ns, out, { ts: Date.now(), program, ok });
}
