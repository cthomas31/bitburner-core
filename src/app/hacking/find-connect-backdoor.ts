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
import { run } from "/lib/singularity.js";

export async function main(ns: NS): Promise<boolean> {
    const target = ns.args[0] as string;
    if (!target) {
        ns.tprint("Target hostname is required as first argument");
        return false;
    }
    const start = "home";
    const path = await findPath(ns, target, start);
    let ok = false;

    if (path !== null) {
        for (const host of path) {
            const res = await run(ns, "connect-to-server", [host]) as { ok?: boolean } | null;
            if (res === null || res.ok === false) {
                ns.tprint(`[find-connect-backdoor] Failed to connect to ${host}`);
                break;
            }
        }
        const res = await run(ns, "backdoor", []) as { ok?: boolean } | null;
        if (res === null || res.ok === false) {
            ns.tprint(`[find-connect-backdoor] Failed to backdoor ${target}`);
        }
        ok = res?.ok ?? false;
        await run(ns, "connect-to-server", ["home"]);
    }

    return ok;
}
