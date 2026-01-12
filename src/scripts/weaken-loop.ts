/**
 * scripts/weaken-loop.ts
 *
 * Weaken loop script that continuously weakens a specified target server.
 */

import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string;
    if (!target) {
        ns.tprint("Usage: run scripts/weaken-loop.js <target>");
        return;
    }
    for (; ;) {
        await ns.weaken(target);
        await ns.sleep(500);
    }
}
