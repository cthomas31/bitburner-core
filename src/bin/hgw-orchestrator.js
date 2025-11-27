import { getRootedServers } from "/lib/network.js";
import { MONEY_THRESHOLD, SECURITY_MARGIN, HACK_MARGIN } from "/lib/constants";

/** @param {NS} ns **/
export async function main(ns) {
    const args = ns.flags([
        ["target", ""],
        ["moneyPct", MONEY_THRESHOLD],  // desired fraction of max money
        ["secMargin", SECURITY_MARGIN], // allowed security above min
        ["hackPct", HACK_MARGIN],       // try to steal up to 10% per wave
        ["interval", 2000],             // ms between decisions
    ]);

    if (!args.target) {
        ns.tprint("Usage: run bin/hgw-orchestrator.js --target <hostname> [--moneyPct 0.8] [--secMargin 3]");
        return;
    }

    const target = args.target;
    const moneyPct = args.moneyPct;
    const secMargin = args.secMargin;
    const hackPct = args.hackPct;
    const interval = args.interval;

    ns.print(`Starting HGW orchestrator for ${target}`);
    ns.disableLog("getServer");
    ns.disableLog("getServerMoneyAvailable");
    ns.disableLog("getServerSecurityLevel");
    ns.disableLog("sleep");

    while (true) {
        const s = ns.getServer(target);
        const minSec = s.minDifficulty;
        const sec = s.hackDifficulty;
        const secDelta = sec - minSec;

        const maxMoney = s.moneyMax;
        const money = s.moneyAvailable;
        const moneyRatio = maxMoney > 0 ? money / maxMoney : 0;

        const player = ns.getPlayer();

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
        const weakenRam = ns.getScriptRam("/scripts/weaken-once.js", "home");
        const growRam = ns.getScriptRam("/scripts/grow-once.js", "home");
        const hackRam = ns.getScriptRam("/scripts/hack-once.js", "home");

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
            await launchDistributed(ns, "/scripts/weaken-once.js", target, weakenToLaunch);
        }
        if (growToLaunch > 0) {
            await launchDistributed(ns, "/scripts/grow-once.js", target, growToLaunch);
        }
        if (hackToLaunch > 0) {
            await launchDistributed(ns, "/scripts/hack-once.js", target, hackToLaunch);
        }

        ns.print(
            `sec=${sec.toFixed(2)} (min ${minSec}), money=${ns.nFormat(money, "0.0a")}/${ns.nFormat(
                maxMoney,
                "0.0a"
            )} ratio=${(moneyRatio * 100).toFixed(1)}% | W=${weakenToLaunch} G=${growToLaunch} H=${hackToLaunch}`
        );

        await ns.sleep(interval);
    }
}

/**
 * Sum of free RAM over all rooted servers.
 *
 * @param {NS} ns
 */
async function totalFreeRam(ns) {
    let total = 0;
    const servers = await getRootedServers(ns);
    for (const host of servers) {
        const max = ns.getServerMaxRam(host);
        const used = ns.getServerUsedRam(host);
        total += Math.max(0, max - used);
    }
    return total;
}

async function launchDistributed(ns, script, target, totalThreads) {
    if (totalThreads <= 0) return 0;
    const scriptRam = ns.getScriptRam(script, "home");
    if (scriptRam === 0) {
        ns.tprint(`WARN: Script ${script} has 0 RAM or is missing.`);
        return 0;
    }

    const servers = await getRootedServers(ns);
    let remaining = totalThreads;

    for (const host of servers) {
        const maxRam = ns.getServerMaxRam(host);
        const usedRam = ns.getServerUsedRam(host);
        const freeRam = Math.max(0, maxRam - usedRam);
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
