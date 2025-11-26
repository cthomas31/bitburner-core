/**
 * scan-network.js
 *
 * Discover all reachable servers starting from 'home', attempt to gain root on them
 * using any available port-opening programs, and save their metadata to a file.
 * The network data includes whether the server is rooted, max money, required hacking
 * level, min security level, RAM, and number of ports required.
 *
 * Usage: run scripts/scan-network.js
 *
 * Output: writes a JSON object to /data/network.json
 *
 * Dependencies: lib/network.js, lib/ns-io.js, lib/constants.js
 */

import { buildNetworkMap, explore } from '/lib/network.js';
import { writeJSON } from '/lib/ns-io.js';
import { NETWORK_FILE } from '/lib/constants.js';

/** @param {NS} ns */
export async function main(ns) {

  /**
   * Attempt to gain root access on a server by opening the required number of ports.
   * Only tries port programs you currently own. Does nothing if already rooted.
   *
   * @param {string} host
   * @param {number} portsReq
   */
  async function tryRoot(host, portsReq) {
    if (ns.hasRootAccess(host)) return;
    let portsOpened = 0;
    if (portsReq > 0 && ns.fileExists('BruteSSH.exe', 'home')) {
      ns.brutessh(host);
      portsOpened++;
    }
    if (portsReq > 1 && ns.fileExists('FTPCrack.exe', 'home')) {
      ns.ftpcrack(host);
      portsOpened++;
    }
    if (portsReq > 2 && ns.fileExists('relaySMTP.exe', 'home')) {
      ns.relaysmtp(host);
      portsOpened++;
    }
    if (portsReq > 3 && ns.fileExists('HTTPWorm.exe', 'home')) {
      ns.httpworm(host);
      portsOpened++;
    }
    if (portsReq > 4 && ns.fileExists('SQLInject.exe', 'home')) {
      ns.sqlinject(host);
      portsOpened++;
    }
    // If we've opened enough ports, nuke the server.
    if (portsOpened >= portsReq) {
      try {
        ns.nuke(host);
        network[host].rooted = true;
        ns.print(`Rooted ${host}`);
      } catch (e) {
        ns.print(`Failed to nuke ${host}: ${e}`);
      }
    }
  }

  const start = "home";
  const network = await buildNetworkMap(ns, start);

  await explore(ns, {
    start,
    visit: async (host, { depth, parent }) => {
      if (host === 'home') return;
      tryRoot(host, network[host].numOpenPortsRequired);
      return;
    }
  });

  await writeJSON(ns, NETWORK_FILE, network);
  ns.tprint(`scan-network: discovered ${Object.keys(network).length} servers (saved to ${NETWORK_FILE})`);
}