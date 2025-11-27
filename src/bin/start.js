/**
 * start.js
 *
 * Orchestrate the early-game automation by running the network scan,
 * scoring targets and deploying hack loops. This script should be run
 * whenever you want to (re)deploy your hacking scripts.
 *
 * Usage: run bin/start.js
 */

/** @param {NS} ns */
export async function main(ns) {
  // Kick off a network scan; allow it to finish before proceeding
  ns.run('scripts/scan-network.js', 1);
  await ns.sleep(2000);

  // Score the discovered servers
  ns.run('scripts/score-targets.js', 1);
  await ns.sleep(2000);

  // Deploy hacking loops
  ns.run('scripts/deploy-hack.js', 1);
}