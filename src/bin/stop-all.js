/**
 * Run killall on all rooted servers.
 *
* Usage: run bin/stop-all.js
 *
 */

import { getRootedServers } from "/lib/network";

/**
 * @param {NS} ns
 */
export async function main(ns) {
    ns.disableLog("scan");
    ns.disableLog("killall");
  
    const hosts = await getRootedServers(ns);
  
    for (const host of hosts) {
      if (host === "home") continue;
  
      ns.killall(host);
      ns.tprint(`[stop-all] ${host}: killed all scripts`);
    }
}