/**
 * scripts/weaken-once.ts
 *
 * Execute a single weaken operation on the target server.
 */

import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string;
    if (!target) {
        //ns.tprint("Usage: run scripts/weaken-once.js <target>");
        return;
    }
    await ns.weaken(target);
}
