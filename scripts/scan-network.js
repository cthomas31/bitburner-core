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
 * Dependencies: lib/ns-io.js, lib/constants.js
 */

import {readJSON, writeJSON} from '/lib/ns-io.js';
import {NETWORK_FILE} from '/lib/constants.js';

/** @param {NS} ns */
export async function main(ns) {
  // Object keyed by server name. Each entry contains details about the server.
  const network = {};
  const visited = new Set();

  /**
   * Recursively explore the network starting from a given server.
   * Uses depth-first traversal to find all connected servers.
   *
   * @param {string} server
   */
  async function explore(server) {
    visited.add(server);
    const neighbors = ns.scan(server);
    for (const neighbor of neighbors) {
      if (neighbor === 'home' || visited.has(neighbor)) continue;
      // gather static metadata
      const maxMoney = ns.getServerMaxMoney(neighbor);
      const minSec   = ns.getServerMinSecurityLevel(neighbor);
      const reqHack  = ns.getServerRequiredHackingLevel(neighbor);
      const portsReq = ns.getServerNumPortsRequired(neighbor);
      const ram      = ns.getServerUsedRam(neighbor);
      const rooted   = ns.hasRootAccess(neighbor);
      network[neighbor] = {
        name: neighbor,
        maxMoney,
        minSec,
        reqHack,
        portsReq,
        ram,
        rooted
      };
      // attempt to gain root if possible
      await tryRoot(neighbor, portsReq);
      await explore(neighbor);
    }
  }

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

  await explore('home');
  await writeJSON(ns, NETWORK_FILE, network);
  ns.tprint(`scan-network: discovered ${Object.keys(network).length} servers (saved to ${NETWORK_FILE})`);
}