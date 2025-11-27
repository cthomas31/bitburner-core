/**
 * stop.js
 *
 * Kill all instances of hack-loop.js across all rooted servers. This is useful
 * to clean up running scripts before redeploying or when you're ready to shut
 * down your automation.
 *
 * Usage: run bin/stop.js
 */

import {readJSON} from '/lib/ns-io.js';
import {NETWORK_FILE} from '/lib/constants.js';

/** @param {NS} ns */
export async function main(ns) {
  const network = await readJSON(ns, NETWORK_FILE) || {};
  const script = '/scripts/hack-loop.js';

  // Kill the script on home first
  if (ns.scriptRunning(script, 'home')) {
    ns.scriptKill(script, 'home');
    ns.print(`Killed hack-loop on home`);
  }
  // Iterate over rooted servers and kill hack-loop
  for (const host of Object.keys(network)) {
    if (ns.scriptRunning(script, host)) {
      ns.scriptKill(script, host);
      ns.print(`Killed hack-loop on ${host}`);
    }
  }
  ns.tprint('stop: all hack-loop scripts terminated');
}