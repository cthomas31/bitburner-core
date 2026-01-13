/**
 * scripts/grow-once.ts
 *
 * Execute a single grow operation on the target server.
 */

import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string;
    if (!target) {
        //ns.tprint("Usage: run scripts/grow-once.js <target>");
        return;
    }
    await ns.grow(target);
}
