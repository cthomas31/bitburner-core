/**
 *
 * Fill pservs (or all rooted servers) with XP weaken-only workers pointed at top XP targets.
 */

import type { NS } from "@ns";
import { getBestXpTargets } from "/lib/targets.js";
import { getNumber } from "/lib/settings.js";

const XP_SCRIPT = "/workers/xp_weaken.js";
const LEGACY_XP_SCRIPT = "/workers/xp.js";

export async function main(ns: NS): Promise<void> {
    ns.disableLog("scan");
    ns.disableLog("sleep");
    ns.disableLog("scp");
    ns.disableLog("getServerMaxRam");
    ns.disableLog("getServerUsedRam");

    const useOnlyPservs = false; // set false if you want all rooted servers, not just pservs

    const configuredTargetCount = getNumber(ns, "controller.hacking.xpTargetCount");
    const argTargetCount = Number(ns.args[0]);
    const xpTargetCount = Number.isFinite(argTargetCount) && argTargetCount > 0
        ? Math.floor(argTargetCount)
        : Math.max(1, Math.floor(configuredTargetCount || 1));

    // 1) Pick best XP targets
    const xpTargets = await getBestXpTargets(ns, xpTargetCount);
    const xpTargetNames = xpTargets.map(t => t.hostname);
    ns.tprint(`[deploy-xp] XP targets selected (${xpTargets.length}): ${xpTargetNames.join(", ")}`);

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
        // Kill only XP workers we own
        const procs = ns.ps(host);
        for (const p of procs) {
            if (p.filename === XP_SCRIPT || p.filename === LEGACY_XP_SCRIPT) {
                ns.kill(p.pid);
            }
        }

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

        // Round-robin distribute threads across targets
        const allocations = new Map<string, number>();
        for (let i = 0; i < threads; i++) {
            const target = xpTargets[i % xpTargets.length].hostname;
            allocations.set(target, (allocations.get(target) ?? 0) + 1);
        }

        const results: string[] = [];
        for (const [target, t] of allocations) {
            const pid = ns.exec(XP_SCRIPT, host, t, target);
            if (pid === 0) {
                ns.print(`[deploy-xp] Failed to start XP worker on ${host} -> ${target}`);
            } else {
                results.push(`${target} x${t}`);
            }
        }

        ns.tprint(`[deploy-xp] ${host}: ${results.join(", ")}`);
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
