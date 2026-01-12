/**
 * scripts/singularity/connect-to-server.ts
 *
 * Connect to a specified server and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io.js";

export async function main(ns: NS): Promise<void> {
    const hostname = String(ns.args[0] ?? "");
    const out = String(ns.args[1] ?? "data/singularity/connect-to-server.json");

    const ok = await ns.singularity.connect(hostname);
    await writeJSON(ns, out, { ts: Date.now(), hostname, ok });
}
