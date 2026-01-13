/**
 *
 * Fill pservs (or all rooted servers) with xp-worker.js pointed at best XP target.
 */

import type { NS } from "@ns";
import { getBestXpTarget } from "/lib/targets.js";

const XP_SCRIPT = "/workers/xp.js";

export async function main(ns: NS): Promise<void> {
    ns.disableLog("scan");
    ns.disableLog("sleep");
    ns.disableLog("scp");
    ns.disableLog("getServerMaxRam");
    ns.disableLog("getServerUsedRam");

    const useOnlyPservs = false; // set false if you want all rooted servers, not just pservs

    // 1) Pick best XP target via Formulas
    const xpTargetInfo = getBestXpTarget(ns);
    const xpTarget = xpTargetInfo?.hostname || "n00dles";
    //const xpTarget = "joesguns"; // temporarily disable Formulas use
    ns.tprint(`[deploy-xp] Best XP target selected: ${xpTarget}`);

    // 2) Determine script RAM
    const scriptRam = ns.getScriptRam(XP_SCRIPT);
    if (!scriptRam || scriptRam <= 0) {
        ns.tprint(`[deploy-xp] Cannot read RAM for ${XP_SCRIPT}. Did you save it?`);
        return;
    }

    // 3) Determine hosts to use
    const hosts = useOnlyPservs ? ns.getPurchasedServers() : await discoverRooted(ns);

    if (!hosts.length) {
        ns.tprint("[deploy-xp] No hosts found to deploy to.");
        return;
    }

    // 4) Deploy xp-worker.js to each host and fill with threads
    for (const host of hosts) {
        if (host === "home") continue; // optional, keep home clean

        // Kill everything on the host so XP gets full RAM
        const procs = ns.ps(host);
        for (const p of procs) ns.kill(p.pid);

        // Copy script
        await ns.scp(XP_SCRIPT, host);

        const maxRam = ns.getServerMaxRam(host);
        const usedRam = ns.getServerUsedRam(host);
        const freeRam = Math.max(0, maxRam - usedRam);
        const threads = Math.floor(freeRam / scriptRam);

        if (threads < 1) {
            ns.print(`[deploy-xp] No RAM on ${host} for XP worker`);
            continue;
        }

        const pid = ns.exec(XP_SCRIPT, host, threads, xpTarget);
        if (pid === 0) {
            ns.print(`[deploy-xp] Failed to start XP worker on ${host}`);
        } else {
            ns.tprint(`[deploy-xp] ${host}: xp-worker.js x${threads} -> ${xpTarget}`);
        }
    }
}

/**
 * Scan rooted servers if not just pservs.
 * Returns all servers with admin rights and RAM > 0.
 */
async function discoverRooted(ns: NS): Promise<string[]> {
    const seen = new Set<string>();
    const stack = ["home"];
    let h: string | undefined;
    while ((h = stack.pop()) !== undefined) {
        if (seen.has(h)) continue;
        seen.add(h);
        for (const n of ns.scan(h)) stack.push(n);
    }
    return Array.from(seen).filter(h => {
        const s = ns.getServer(h);
        return s.hasAdminRights && s.maxRam > 0;
    });
}
