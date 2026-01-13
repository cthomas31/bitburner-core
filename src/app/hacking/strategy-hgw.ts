/**
 * scripts/hgw/orchestrator.ts
 *
 * HGW (Hack-Grow-Weaken) orchestrator that manages distributed hacking operations.
 * Coordinates weaken, grow, and hack operations across all rooted servers.
 */

import type { NS } from "@ns";
import { getRootedServers } from "/lib/network.js";
import { HACK_CONFIG } from "/lib/constants.js";
import { formatMoney } from "/lib/util.js";

export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string;

    if (!target) {
        ns.tprint("Usage: run scripts/hgw/orchestrator.js --target <hostname> [--moneyPct 0.8] [--secMargin 3]");
        return;
    }

    const moneyPct = HACK_CONFIG.moneyThreshold;
    const secMargin = HACK_CONFIG.securityMargin;
    const hackPct = HACK_CONFIG.hackMargin;
    const interval = 3000; // Loop interval in ms (not in HACK_CONFIG, using default)

    ns.print(`Starting HGW orchestrator for ${target}`);
    ns.disableLog("getServer");
    ns.disableLog("getServerMoneyAvailable");
    ns.disableLog("getServerSecurityLevel");
    ns.disableLog("getServerUsedRam");
    ns.disableLog("getServerMaxRam");
    ns.disableLog("sleep");
    ns.disableLog("scan");
    ns.disableLog("scp");

    for (; ;) {
        const s = ns.getServer(target);
        const minSec = s.minDifficulty ?? 0;
        const sec = s.hackDifficulty ?? 0;
        const secDelta = sec - minSec;

        const maxMoney = s.moneyMax ?? 0;
        const money = s.moneyAvailable ?? 0;
        const moneyRatio = maxMoney > 0 ? money / maxMoney : 0;

        // Decide how many threads we *want*
        let weakenThreadsNeeded = 0;
        let growThreadsNeeded = 0;
        let hackThreadsNeeded = 0;

        // 1) Fix security if too high
        if (secDelta > secMargin) {
            // weakenAnalyze(threads, cores) -> sec reduction
            const perThread = ns.weakenAnalyze(1, 1);
            weakenThreadsNeeded = Math.ceil(secDelta / perThread);
        }

        // 2) Fix money if too low
        if (maxMoney > 0 && moneyRatio < moneyPct) {
            // growthAnalyze(server, growthFactor) -> threads
            const desired = moneyPct * maxMoney;
            const current = Math.max(money, 1);
            const factor = desired / current;

            // Don't ask for absurd growth in one tick
            const clampedFactor = Math.min(factor, 50);
            growThreadsNeeded = Math.ceil(ns.growthAnalyze(target, clampedFactor, 1));
        }

        // 3) Only hack if we're "prepped enough"
        if (secDelta <= secMargin && moneyRatio >= moneyPct) {
            const stealAmount = maxMoney * hackPct;
            const estHackThreads = ns.hackAnalyzeThreads(target, stealAmount);
            if (isFinite(estHackThreads) && estHackThreads > 0) {
                hackThreadsNeeded = Math.floor(estHackThreads);
            }
        }

        // Figure out how many threads are even available across the fleet
        const totalRamFree = await totalFreeRam(ns);
        ns.print(`Total free RAM: ${totalRamFree.toFixed(2)} GB`);
        const weakenRam = ns.getScriptRam("/workers/weaken.js", "home");
        const growRam = ns.getScriptRam("/workers/grow.js", "home");
        const hackRam = ns.getScriptRam("/workers/hack.js", "home");

        // Allocate threads in priority order: weaken -> grow -> hack

        let ramLeft = totalRamFree;

        // Weaken first
        let weakenToLaunch = 0;
        if (weakenThreadsNeeded > 0) {
            weakenToLaunch = Math.min(
                weakenThreadsNeeded,
                Math.floor(ramLeft / weakenRam)
            );
            ramLeft -= weakenToLaunch * weakenRam;
        }

        // Then grow
        let growToLaunch = 0;
        if (ramLeft > 0 && growThreadsNeeded > 0) {
            growToLaunch = Math.min(
                growThreadsNeeded,
                Math.floor(ramLeft / growRam)
            );
            ramLeft -= growToLaunch * growRam;
        }

        // Then hack
        let hackToLaunch = 0;
        if (ramLeft > 0 && hackThreadsNeeded > 0) {
            hackToLaunch = Math.min(
                hackThreadsNeeded,
                Math.floor(ramLeft / hackRam)
            );
        }

        // Fire off the waves
        if (weakenToLaunch > 0) {
            await launchDistributed(ns, "/workers/weaken.js", target, weakenToLaunch);
        }
        if (growToLaunch > 0) {
            await launchDistributed(ns, "/workers/grow.js", target, growToLaunch);
        }
        if (hackToLaunch > 0) {
            await launchDistributed(ns, "/workers/hack.js", target, hackToLaunch);
        }

        ns.print(`sec=${sec.toFixed(2)} (min ${minSec})`);
        ns.print(`money=${formatMoney(money)}/${formatMoney(maxMoney)} ratio=${(moneyRatio * 100).toFixed(1)}%`);
        ns.print(`totalRamFree=${totalRamFree.toFixed(2)} W=${weakenToLaunch} G=${growToLaunch} H=${hackToLaunch}`);

        await ns.sleep(interval);
    }
}

/**
 * Sum of free RAM over all rooted servers.
 */
async function totalFreeRam(ns: NS): Promise<number> {
    let total = 0;
    const servers = await getRootedServers(ns);
    for (const host of servers) {
        const max = ns.getServerMaxRam(host);
        const used = ns.getServerUsedRam(host);
        total += Math.max(0, max - used);
        if (host === "home") {
            total -= Math.max(0, HACK_CONFIG.homeReservedRam);
        }
    }
    return total;
}

/**
 * Launch a script distributed across all available servers.
 * Returns the number of threads actually launched.
 */
async function launchDistributed(ns: NS, script: string, target: string, totalThreads: number): Promise<number> {
    if (totalThreads <= 0) return 0;
    const scriptRam = ns.getScriptRam(script, "home");
    if (scriptRam === 0) {
        ns.tprint(`WARN: Script ${script} has 0 RAM or is missing.`);
        return 0;
    }

    const rootedServers = await getRootedServers(ns);
    const pservers = ns.getPurchasedServers();
    const servers = [...rootedServers, ...pservers];
    let remaining = totalThreads;

    for (const host of servers) {
        const maxRam = ns.getServerMaxRam(host);
        const usedRam = ns.getServerUsedRam(host);
        const freeRam = Math.max(0, maxRam - usedRam) - (host === "home" ? HACK_CONFIG.homeReservedRam : 0);
        const possibleThreads = Math.floor(freeRam / scriptRam);
        if (possibleThreads <= 0) continue;

        // ensure the script is present on this host
        if (host !== "home") {
            await ns.scp(script, host, "home");
        }

        const threads = Math.min(possibleThreads, remaining);
        if (threads <= 0) continue;

        ns.exec(script, host, threads, target);
        remaining -= threads;
        if (remaining <= 0) break;
    }

    return totalThreads - remaining;
}
