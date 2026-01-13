/**
 * scripts/hack-once.ts
 *
 * Execute a single hack operation on the target server.
 */

import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string;
    if (!target) {
        //ns.tprint("Usage: run workers/hack.js <target>");
        return;
    }
    await ns.hack(target);
}
