/**
 * deploy-hack.js
 *
 * Deploy the hack-loop script to all rooted servers and start them against the best target.
 * This script reads the target rankings computed by score-targets.js and chooses the highest-ranked server.
 * It then copies hack-loop.js to each rooted server, kills any existing instance of hack-loop.js,
 * and starts as many threads as fit within the configured thread buffer.
 *
 * Usage: run scripts/deploy-hack.js
 *
 * Dependencies: lib/ns-io.js, lib/constants.js
 */

import {readJSON} from '/lib/ns-io.js';
import {
  NETWORK_FILE,
  TARGETS_FILE,
  MONEY_THRESHOLD,
  SECURITY_MARGIN,
  THREAD_BUFFER,
  HOME_RESERVED_RAM,
  HOME_HACK_LOOP_DEPLOY
} from '/lib/constants.js';

/** @param {NS} ns */
export async function main(ns) {
  const network = await readJSON(ns, NETWORK_FILE) || {};
  const targets = await readJSON(ns, TARGETS_FILE) || [];
  if (!targets.length) {
    ns.tprint('deploy-hack: no targets available. Run scripts/score-targets.js first.');
    return;
  }
  const target = targets[0].host;
  ns.tprint(`deploy-hack: deploying hack-loop against ${target}`);

  const script = '/scripts/hack-loop.js';

  let networkHosts = Object.keys(network);
  if (HOME_HACK_LOOP_DEPLOY) {
    if (!networkHosts.includes("home")) {
      networkHosts.push("home");
    }
  }

  for (const host of networkHosts) {
    const info = network[host];
    if (host !== 'home' && !info.rooted) continue;
    // Determine available RAM on the host
    const maxRam = ns.getServerMaxRam(host);
    const usedRam = ns.getServerUsedRam(host);
    let freeRam = maxRam - usedRam;
    if (host === 'home') {
      // Reserve some RAM on home for other tasks
      freeRam -= HOME_RESERVED_RAM;
    }
    if (freeRam < 2) continue;

    // Copy hack-loop.js to the target host
    await ns.scp(['scripts/hack-loop.js'], host, 'home');
    // Kill any existing hack-loop running on this host
    if (ns.scriptRunning(script, host)) {
      ns.scriptKill(script, host);
      // wait briefly to ensure RAM is freed
      await ns.sleep(50);
    }

    const scriptRam = ns.getScriptRam(script, host);
    if (scriptRam <= 0) {
      ns.print(`deploy-hack: unable to determine RAM cost of ${script}`);
      continue;
    }
    const threads = Math.floor((freeRam * THREAD_BUFFER) / scriptRam);
    if (threads < 1) continue;

    const pid = ns.exec(script, host, threads, target, MONEY_THRESHOLD, SECURITY_MARGIN);
    if (pid !== 0) {
      ns.print(`Started ${script} on ${host} (${threads} threads) targeting ${target}`);
    }
  }
}