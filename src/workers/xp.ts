/**
 * scripts/xp/worker.ts
 *
 * XP worker: hack for XP, weaken when security drifts above min.
 *
 * Usage:
 *   run scripts/xp/worker.js <target>
 */

import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    const target = String(ns.args[0] ?? "");
    if (!target) {
        ns.tprint("[xp-worker] No target specified.");
        return;
    }

    // How far above min difficulty we're willing to tolerate before weakening.
    const SEC_BUFFER = 3; // try 1–3; smaller = more time spent weakening

    // ns.disableLog("getServer");
    // ns.disableLog("hack");
    // ns.disableLog("weaken");
    // ns.disableLog("sleep");

    for (; ;) {
        const s = ns.getServer(target);
        const overMin = (s.hackDifficulty ?? 0) - (s.minDifficulty ?? 0);

        if (overMin > SEC_BUFFER) {
            // Security has drifted up: push it back down.
            await ns.weaken(target);
        } else {
            // Security is close enough to min: farm XP.
            await ns.hack(target);
        }

        await ns.sleep(1);
    }
}
