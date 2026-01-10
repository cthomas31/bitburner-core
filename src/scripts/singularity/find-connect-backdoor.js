/**
 * find.js
 *
 * Find a host by name and print the path from "home" to that host.
 * Also prints a one-liner you can paste to connect step-by-step.
 *
 * Usage: run bin/find.js <target-hostname>
 *
 * Dependencies: lib/network.js
 */

import { findPath } from '/lib/network.js';
import { writeJSON } from "/lib/ns-io.js";

/** @param {NS} ns */
export async function main(ns) {
    const target = ns.args[0];
    const out = ns.args[1] || "data/singularity/find-connect-backdoor.json";
    const start = 'home';
    const path = await findPath(ns, target, start);
    let ok = false;
    if (path !== null) {
        for (const host of path) {
            ns.singularity.connect(host);
        }
        ok = await ns.singularity.installBackdoor();
        ns.singularity.connect("home");
    }

    await writeJSON(ns, out, { ts: Date.now(), target, path, ok });
}
