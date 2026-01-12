/**
 * scripts/pserv-manager.ts
 *
 * One-file fleet manager for purchased servers that decides:
 *   - Whether to spawn a new pserv (costs money, adds capacity)
 *   - Whether to up-size an existing pserv (RAM * 2, replaces old one)
 *   - When to do nothing because payback would take too long
 *
 * Strategy (ROI based):
 *   - Each pserv earns $/sec ≈ threadsOnIt * hackIncome (a rough per-thread rate).
 *   - Candidates:
 *       * New pserv (smallest affordable RAM)
 *       * Upgrade each existing pserv (to next RAM tier)
 *   - Pick the one with the shortest payback time (cost / Δ$perSec).
 *   - Reject anything over maxPaybackSeconds or out of budget.
 *
 * Usage:
 *   run scripts/pserv-manager.js [--deploy bin/controller.js]
 *
 * Flags:
 *   --deploy <script>  After buying/upgrading, copy this script to the new
 *                      server and run it. Defaults to bin/controller.js.
 *
 * Dependencies:
 *   - lib/constants.js (PSERV_CONFIG)
 */

import type { NS } from "@ns";
import { PSERV_CONFIG } from "/lib/constants.js";
import { formatMoney } from "/lib/util.js";

// ============== Type Definitions ==============

interface UpgradeCandidate {
    hostname: string;
    oldRam: number;
    newRam: number;
    cost: number;
    payback: number;
}

interface PservConfig {
    maxSpendFraction: number;
    maxPaybackSeconds: number;
    threadIncomePerSec: number;
    idleLoopMs: number;
    activeLoopMs: number;
    prefix: string;
    maxServers: number;
}

// ============== Main Entry Point ==============

export async function main(ns: NS): Promise<void> {
    ns.disableLog("ALL");

    const flags = ns.flags([["deploy", "bin/controller.js"]]) as { deploy: string };
    const deployScript: string = flags.deploy ?? "bin/controller.js";

    // Config with defaults - using actual PSERV_CONFIG property names
    const cfg: PservConfig = {
        maxSpendFraction: PSERV_CONFIG.maxSpendFraction ?? 0.25,
        maxPaybackSeconds: PSERV_CONFIG.roiMaxPaybackSeconds ?? 6 * 60 * 60,
        threadIncomePerSec: 10_000, // Not in config, use hardcoded default
        idleLoopMs: 60_000, // Not in config, use hardcoded default
        activeLoopMs: 5_000, // Not in config, use hardcoded default
        prefix: PSERV_CONFIG.hostnamePrefix ?? "pserv-",
        maxServers: ns.getPurchasedServerLimit(),
    };

    ns.print(`[pserv-manager] Config: maxSpend=${(cfg.maxSpendFraction * 100).toFixed(0)}%, payback<=${ns.tFormat(cfg.maxPaybackSeconds * 1000)}`);

    for (; ;) {
        await manageFleetROI(ns, cfg, deployScript);
        await ns.sleep(cfg.idleLoopMs);
    }
}

// ============== Fleet Management ==============

/**
 * One iteration of the manager.
 *
 * 1) Build candidate list (new servers + upgrades).
 * 2) Pick shortest payback if affordable.
 * 3) Execute purchase/upgrade and deploy script.
 */
async function manageFleetROI(
    ns: NS,
    cfg: PservConfig,
    deployScript: string
): Promise<void> {
    const money = ns.getServerMoneyAvailable("home");
    const budget = money * cfg.maxSpendFraction;

    const owned = ns.getPurchasedServers();
    const ownedSet = new Set(owned);
    const maxRam = ns.getPurchasedServerMaxRam();

    const candidates: UpgradeCandidate[] = [];

    // Candidate: buy a new server
    if (owned.length < cfg.maxServers) {
        const newRam = bestRamWithinBudget(ns, budget, maxRam);
        if (newRam >= 2) {
            const cost = ns.getPurchasedServerCost(newRam);
            addCandidate(ns, candidates, cfg, {
                hostname: "<new>",
                oldRam: 0,
                newRam,
                cost,
            });
        }
    }

    // Candidate: upgrade each existing server
    for (const host of owned) {
        const currentRam = ns.getServerMaxRam(host);
        if (currentRam >= maxRam) continue;

        const newRam = Math.min(currentRam * 2, maxRam);
        const cost = ns.getPurchasedServerUpgradeCost(host, newRam);
        if (!isFinite(cost) || cost <= 0) continue;

        addCandidate(ns, candidates, cfg, {
            hostname: host,
            oldRam: currentRam,
            newRam,
            cost,
        });
    }

    // Pick best candidate
    candidates.sort((a, b) => a.payback - b.payback);
    const best = candidates[0];

    if (!best || best.payback > cfg.maxPaybackSeconds || best.cost > budget) {
        ns.print("[pserv-manager] No profitable action. Idle.");
        return;
    }

    // Execute action
    if (best.hostname === "<new>") {
        // Buy new server
        const newHostname = cfg.prefix + nextServerIndex(ns, ownedSet, cfg.prefix);
        const purchased = ns.purchaseServer(newHostname, best.newRam);
        if (purchased !== "") {
            ns.print(`[pserv-manager] PURCHASED ${purchased} ${ns.formatRam(best.newRam)} for ${formatMoney(best.cost)} (payback ${ns.tFormat(best.payback * 1000)})`);
            await deployToHost(ns, purchased, deployScript);
        } else {
            ns.print("[pserv-manager] purchase failed (funds moved?)");
        }
    } else {
        // Upgrade existing server
        const host = best.hostname;
        await killAllOnHost(ns, host);

        // Use upgradePurchasedServer which preserves hostname
        const upgraded = ns.upgradePurchasedServer(host, best.newRam);
        if (upgraded) {
            ns.print(`[pserv-manager] UPGRADED ${host} to ${ns.formatRam(best.newRam)} for ${formatMoney(best.cost)} (payback ${ns.tFormat(best.payback * 1000)})`);
            await deployToHost(ns, host, deployScript);
        } else {
            ns.print(`[pserv-manager] upgrade ${host} failed`);
        }
    }
}

// ============== Utility Functions ==============

/**
 * Estimate $/sec income a host with `threads` adds, very rough.
 */
function estimateThreadIncome(
    cfg: PservConfig,
    threads: number
): number {
    return threads * cfg.threadIncomePerSec;
}

/**
 * Add a candidate to the list, computing payback.
 */
function addCandidate(
    ns: NS,
    candidates: UpgradeCandidate[],
    cfg: PservConfig,
    base: {
        hostname: string;
        oldRam: number;
        newRam: number;
        cost: number;
    }
): void {
    // Estimate threads gained (assuming ~1.75 GB per thread, hack script size).
    const scriptRam = 1.75;
    const oldThreads = Math.floor(base.oldRam / scriptRam);
    const newThreads = Math.floor(base.newRam / scriptRam);
    const deltaThreads = newThreads - oldThreads;

    if (deltaThreads <= 0) return;

    const deltaProd = estimateThreadIncome(cfg, deltaThreads);
    if (deltaProd <= 0) return;

    const payback = base.cost / deltaProd;

    candidates.push({
        hostname: base.hostname,
        oldRam: base.oldRam,
        newRam: base.newRam,
        cost: base.cost,
        payback,
    });
}

/**
 * Find the largest RAM tier affordable within budget (power-of-two).
 */
function bestRamWithinBudget(ns: NS, budget: number, maxRam: number): number {
    let ram = 2;
    while (ram <= maxRam) {
        const cost = ns.getPurchasedServerCost(ram);
        if (cost > budget) {
            return ram / 2;
        }
        ram *= 2;
    }
    // If even max is affordable, clamp to max
    const costMax = ns.getPurchasedServerCost(maxRam);
    if (costMax <= budget) return maxRam;
    return ram / 2;
}

/**
 * Kill all scripts running on a host.
 */
async function killAllOnHost(ns: NS, host: string): Promise<void> {
    ns.killall(host);
    await ns.sleep(100);
}

/**
 * Copy and run the deploy script on a given host.
 */
async function deployToHost(
    ns: NS,
    host: string,
    deployScript: string
): Promise<void> {
    if (!ns.fileExists(deployScript, "home")) {
        ns.print(`[pserv-manager] deployScript ${deployScript} not found on home.`);
        return;
    }

    // Identify all files needed (simple approach: copy script + lib/)
    await ns.scp(deployScript, host, "home");

    // Also copy libs (controller usually needs /lib/*)
    const libs = ns.ls("home", "/lib/");
    if (libs.length > 0) {
        await ns.scp(libs, host, "home");
    }

    // Additionally copy common binaries if they exist
    const bins = ns.ls("home", "/bin/");
    if (bins.length > 0) {
        await ns.scp(bins, host, "home");
    }

    // Copy scripts folder
    const scripts = ns.ls("home", "/scripts/");
    if (scripts.length > 0) {
        await ns.scp(scripts, host, "home");
    }

    ns.exec(deployScript, host);
    ns.print(`[pserv-manager] deployed ${deployScript} on ${host}`);
}

/**
 * Find the next unused index for our server naming scheme.
 */
function nextServerIndex(
    ns: NS,
    ownedSet: Set<string>,
    prefix: string
): number {
    let idx = 0;
    while (ownedSet.has(prefix + idx)) {
        idx++;
    }
    return idx;
}
