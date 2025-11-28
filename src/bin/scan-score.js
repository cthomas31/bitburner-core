/**
 * Run a scan of the network and score all hackable servers.
 *
 * Usage: run bin/scan-score.js
 * 
 * @param {NS} ns
 *
 */
export async function main(ns) {
    ns.exec("scripts/scan-network.js", "home", 1);
    await ns.sleep(1000);
    ns.exec("scripts/score-targets.js", "home", 1);
}