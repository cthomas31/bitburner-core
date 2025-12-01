// Fill rooted servers with hack-loop.js targeting the best target.

/** @param {NS} ns */

import { getRootedServers } from "/lib/network.js";
import { SECURITY_MARGIN, MONEY_THRESHOLD } from "/lib/constants.js";

const HACK_LOOP_SCRIPT = "/scripts/hack-loop.js";

export async function main(ns) {
  const target = ns.args[0];
  if (!target) {
    ns.tprint("Usage: run scripts/deploy-hack-loop.js <target>");
    return;
  }

  // 2) Determine script RAM
  const scriptRam = ns.getScriptRam(HACK_LOOP_SCRIPT);
  if (!scriptRam || scriptRam <= 0) {
    ns.tprint(`[deploy-hack-loop] Cannot read RAM for ${HACK_LOOP_SCRIPT}. Did you save it?`);
    return;
  }

  // 3) Determine hosts to use
  const hosts = await getRootedServers(ns);

  if (!hosts.length) {
    ns.tprint("[deploy-hack-loop] No hosts found to deploy to.");
    return;
  }

  // 4) Deploy hack-loop.js to each host and fill with threads
  for (const host of hosts) {
    if (host === "home") continue; // optional, keep home clean

    // Kill everything on the host so hack-loop gets full RAM
    ns.killall(host);

    // Copy script
    await ns.scp(HACK_LOOP_SCRIPT, host);

    const maxRam = ns.getServerMaxRam(host);
    const usedRam = ns.getServerUsedRam(host);
    const freeRam = Math.max(0, maxRam - usedRam);
    const threads = Math.floor(freeRam / scriptRam);

    if (threads < 1) {
      ns.print(`[deploy-hack-loop] No RAM on ${host} for hack-loop.js`);
      continue;
    }

    const pid = ns.exec(HACK_LOOP_SCRIPT, host, threads, target, SECURITY_MARGIN, MONEY_THRESHOLD);
    if (pid == 0) {
      ns.print(`[deploy-hack-loop] Failed to start hack-loop.js on ${host}`);
    } else {
      ns.tprint(`[deploy-hack-loop] ${host}: hack-loop.js x${threads} -> ${target}`);
    }
  }
}
