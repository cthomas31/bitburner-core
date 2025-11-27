// scripts/hacknet-manager.js
// Drive Hacknet using ROI (payback time) instead of "cheapest upgrade wins".
//
// Strategy:
//   - Requires Formulas.exe (uses ns.formulas.hacknetNodes.moneyGainRate).
//   - For each loop:
//       * Compute a budget = money * maxSpendFraction.
//       * Evaluate:
//           - buying a new node
//           - +1 level on each existing node
//           - +1 RAM on each existing node
//           - +1 core on each existing node
//       * For each candidate, compute:
//             deltaProd = newMoneyPerSec - currentMoneyPerSec
//             payback   = cost / deltaProd
//         Reject if:
//             - cost > budget
//             - deltaProd <= 0
//             - payback > maxPaybackSeconds
//       * Pick the candidate with the **shortest payback time** and buy it.
//   - If nothing passes the filters, it idles and tries again later.
//
// Usage:
//   run scripts/hacknet-manager.js
//
// Dependencies:
//   - lib/constants.js (HACKNET_CONFIG)

import { HACKNET_CONFIG } from "/lib/constants.js";
import { formatMoney } from "/lib/util.js";

/** @param {NS} ns */
export async function main(ns) {
    ns.disableLog("sleep");
    ns.disableLog("getServerMoneyAvailable");

    if (!ns.fileExists("Formulas.exe", "home") || !ns.formulas?.hacknetNodes) {
        ns.tprint("[hacknet-manager] Formulas.exe not found or formulas API unavailable.");
        ns.tprint("[hacknet-manager] This script expects ns.formulas.hacknetNodes.moneyGainRate().");
        ns.tprint("[hacknet-manager] Either buy Formulas.exe or swap this file for a cheaper-logic version.");
        return;
    }

    const hn = ns.hacknet;
    const formulas = ns.formulas.hacknetNodes;
    const mults = ns.getHacknetMultipliers();
    const prodMult = mults.production ?? 1;

    let constants;
    try {
        constants = formulas.constants();
    } catch {
        // Failsafe: if constants() isn't available for some reason.
        constants = {
            MaxLevel: 200,
            MaxRam: 64,
            MaxCores: 16,
        };
    }

    const maxSpendFraction = HACKNET_CONFIG.maxSpendFraction ?? 0.1;
    const maxPaybackSeconds = HACKNET_CONFIG.maxPaybackSeconds ?? 6 * 60 * 60;
    const idleLoopMs = HACKNET_CONFIG.idleLoopMs ?? 30_000;
    const activeLoopMs = HACKNET_CONFIG.activeLoopMs ?? 5_000;

    ns.print(`[hacknet-manager] Using ROI mode: maxSpend=${(maxSpendFraction * 100).toFixed(1)}% payback<=${ns.tFormat(maxPaybackSeconds * 1000)}`);

    for (;;) {
        const money = ns.getServerMoneyAvailable("home");
        const budget = money * maxSpendFraction;

        const best = findBestHacknetAction(ns, {
            hn,
            formulas,
            prodMult,
            constants,
            budget,
            maxPaybackSeconds,
        });

        if (!best) {
            ns.print(`[hacknet-manager] No profitable upgrades within budget. Sleeping ${idleLoopMs}ms.`);
            await ns.sleep(idleLoopMs);
            continue;
        }

        const { type, nodeIndex, cost, paybackSeconds } = best;
        const paybackStr = ns.tFormat(paybackSeconds * 1000);
        const costStr = formatMoney(cost);

        switch (type) {
            case "new-node":
                if (hn.purchaseNode() !== -1) {
                    ns.print(`[hacknet-manager] BUY NODE for ${costStr} (payback ~${paybackStr})`);
                } else {
                    ns.print("[hacknet-manager] Failed to purchase node (maybe money moved?).");
                }
                break;

            case "level":
                if (hn.upgradeLevel(nodeIndex, 1)) {
                    ns.print(`[hacknet-manager] UPGRADE level on node ${nodeIndex} for ${costStr} (payback ~${paybackStr})`);
                }
                break;

            case "ram":
                if (hn.upgradeRam(nodeIndex, 1)) {
                    ns.print(`[hacknet-manager] UPGRADE RAM on node ${nodeIndex} for ${costStr} (payback ~${paybackStr})`);
                }
                break;

            case "core":
                if (hn.upgradeCore(nodeIndex, 1)) {
                    ns.print(`[hacknet-manager] UPGRADE core on node ${nodeIndex} for ${costStr} (payback ~${paybackStr})`);
                }
                break;
        }

        await ns.sleep(activeLoopMs);
    }
}

/**
 * Decide the single best Hacknet action to take now, based on payback time.
 *
 * Returns:
 *   {
 *     type: "new-node" | "level" | "ram" | "core",
 *     nodeIndex: number | null,
 *     cost: number,
 *     paybackSeconds: number,
 *   }
 * or null if nothing is worth buying.
 */
function findBestHacknetAction(ns, ctx) {
    const { hn, formulas, prodMult, constants, budget, maxPaybackSeconds } = ctx;

    /** @type {null | {type:string,nodeIndex:number|null,cost:number,paybackSeconds:number}} */
    let best = null;

    const numNodes = hn.numNodes();

    // Helper to maybe update `best`
    const consider = (candidate) => {
        if (!candidate) return;
        if (candidate.cost > budget) return;
        if (candidate.paybackSeconds <= 0 || !isFinite(candidate.paybackSeconds)) return;
        if (candidate.paybackSeconds > maxPaybackSeconds) return;

        if (!best || candidate.paybackSeconds < best.paybackSeconds) {
            best = candidate;
        }
    };

    // 1) Consider buying a new node (if any nodes exist, we know starting stats;
    //    otherwise assume 1/1/1 which matches the game defaults).
    {
        const cost = hn.getPurchaseNodeCost();
        if (cost <= budget) {
            let baseLevel = 1;
            let baseRam = 1;
            let baseCores = 1;

            if (numNodes > 0) {
                // Just to be safe, peek at node 0; in practice new nodes start at 1/1/1.
                const s0 = hn.getNodeStats(0);
                baseLevel = s0.level || 1;
                baseRam = s0.ram || 1;
                baseCores = s0.cores || 1;
            }

            const newProd = formulas.moneyGainRate(baseLevel, baseRam, baseCores, prodMult);
            const deltaProd = newProd; // from 0 → newProd
            if (deltaProd > 0) {
                const paybackSeconds = cost / deltaProd;
                consider({
                    type: "new-node",
                    nodeIndex: null,
                    cost,
                    paybackSeconds,
                });
            }
        }
    }

    // 2) Consider upgrades on each existing node.
    for (let i = 0; i < numNodes; i++) {
        const stats = hn.getNodeStats(i);
        const currentProd = formulas.moneyGainRate(stats.level, stats.ram, stats.cores, prodMult);

        // Level +1
        if (stats.level < (constants.MaxLevel ?? 200)) {
            const cost = hn.getLevelUpgradeCost(i, 1);
            if (isFinite(cost) && cost > 0) {
                const newProd = formulas.moneyGainRate(stats.level + 1, stats.ram, stats.cores, prodMult);
                const deltaProd = newProd - currentProd;
                if (deltaProd > 0) {
                    const paybackSeconds = cost / deltaProd;
                    consider({
                        type: "level",
                        nodeIndex: i,
                        cost,
                        paybackSeconds,
                    });
                }
            }
        }

        // RAM +1 upgrade (doubles RAM in-game)
        if (stats.ram < (constants.MaxRam ?? 64)) {
            const cost = hn.getRamUpgradeCost(i, 1);
            if (isFinite(cost) && cost > 0) {
                const newRam = stats.ram * 2;
                const newProd = formulas.moneyGainRate(stats.level, newRam, stats.cores, prodMult);
                const deltaProd = newProd - currentProd;
                if (deltaProd > 0) {
                    const paybackSeconds = cost / deltaProd;
                    consider({
                        type: "ram",
                        nodeIndex: i,
                        cost,
                        paybackSeconds,
                    });
                }
            }
        }

        // Cores +1
        if (stats.cores < (constants.MaxCores ?? 16)) {
            const cost = hn.getCoreUpgradeCost(i, 1);
            if (isFinite(cost) && cost > 0) {
                const newProd = formulas.moneyGainRate(stats.level, stats.ram, stats.cores + 1, prodMult);
                const deltaProd = newProd - currentProd;
                if (deltaProd > 0) {
                    const paybackSeconds = cost / deltaProd;
                    consider({
                        type: "core",
                        nodeIndex: i,
                        cost,
                        paybackSeconds,
                    });
                }
            }
        }
    }

    return best;
}
