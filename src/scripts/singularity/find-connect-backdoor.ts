/**
 * scripts/singularity/find-connect-backdoor.ts
 *
 * Find a host by name and print the path from "home" to that host.
 * Also prints a one-liner you can paste to connect step-by-step.
 *
 * Usage: run bin/find.js <target-hostname>
 *
 * Dependencies: lib/network.js
 */

import type { NS } from "@ns";
import { findPath } from "/lib/network.js";
import { writeJSON } from "/lib/ns-io.js";

export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string;
    const out = String(ns.args[1] ?? "data/singularity/find-connect-backdoor.json");
    const start = "home";
    const path = await findPath(ns, target, start);
    let ok = false;

    if (path !== null) {
        for (const host of path) {
            ns.singularity.connect(host);
        }
        await ns.singularity.installBackdoor();
        ok = true;
        ns.singularity.connect("home");
    }

    await writeJSON(ns, out, { ts: Date.now(), target, path, ok });
}
