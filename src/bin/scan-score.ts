/**
 * Run a scan of the network and score all hackable servers.
 *
 * Usage: run bin/scan-score.js
 */

import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    ns.exec("scripts/pipeline/scan-network.js", "home", 1);
    await ns.sleep(1000);
    ns.exec("scripts/pipeline/score-targets.js", "home", 1);
}
