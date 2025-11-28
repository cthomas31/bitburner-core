// scripts/pserv-manager.js
// Purchased server fleet manager with ROI-based decisions.
//
// Strategy:
//   - Estimate income per thread per second using ns.formulas.hacking on your
//     current best money target, then scale it by roiFudgeFactor.
//   - For each cycle:
//       * Compute budget from maxSpendFraction & minCashReserve.
//       * Enumerate candidates:
//           - Buy a new server at the best power-of-two RAM tier <= budget.
//           - If at cap, replace the weakest server with a larger RAM tier.
//       * For each candidate, compute:
//             deltaThreads = newThreads - oldThreads
//             deltaIncome  = deltaThreads * incomePerThreadPerSec
//             paybackSecs  = cost / deltaIncome
//         Reject if:
//             - cost > budget
//             - deltaThreads < roiMinDeltaThreads
//             - paybackSecs > roiMaxPaybackSeconds
//       * Execute the candidate with the shortest payback time.
//   - Doesn’t deploy scripts; that’s still handled by deploy-hack/bin/start.
//
// Usage:
//   run scripts/pserv-manager.js
//
// Dependencies:
//   - lib/constants.js (PSERV_CONFIG)
//   - lib/targets.js (getBestTarget)

import { PSERV_CONFIG } from "/lib/constants.js";
import { getBestTarget } from "/lib/targets.js";

const WORKER_SCRIPT = "/scripts/hack-loop.js";

/** @param {NS} ns */
export async function main(ns) {
    const cfg = PSERV_CONFIG;
    if (!cfg.enabled) {
        ns.tprint("[pserv-manager] Disabled in constants.js (PSERV_CONFIG.enabled = false).");
        return;
    }

    if (!ns.fileExists("Formulas.exe", "home") || !ns.formulas?.hacking) {
        ns.tprint("[pserv-manager] Formulas.exe not found or formulas API unavailable.");
        ns.tprint("[pserv-manager] This ROI-based version requires ns.formulas.hacking.*.");
        return;
    }

    ns.disableLog("sleep");
    ns.disableLog("getServerMoneyAvailable");

    for (;;) {
        try {
            await manageFleetROI(ns, cfg);
        } catch (e) {
            ns.print(`[pserv-manager] ERROR: ${String(e)}`);
        }

        // Server purchases are rare; we don't need to spam.
        await ns.sleep(30_000);
    }
}

/** @param {NS} ns */
async function manageFleetROI(ns, cfg) {
    const money = ns.getServerMoneyAvailable("home");
    const maxSpend = money * cfg.maxSpendFraction;
    const budget = Math.max(0, Math.min(maxSpend, money - cfg.minCashReserve));

    if (budget <= 0) {
        ns.print("[pserv-manager] No budget (respecting reserve); skipping.");
        return;
    }

    const maxGameRam = ns.getPurchasedServerMaxRam();
    const maxTargetRam = Math.min(cfg.maxTargetRam, maxGameRam);
    if (maxTargetRam < cfg.baseRam) {
        ns.print("[pserv-manager] maxTargetRam < baseRam; nothing to do.");
        return;
    }

    const scriptRam = ns.getScriptRam(WORKER_SCRIPT);
    if (!scriptRam || scriptRam <= 0) {
        ns.print(`[pserv-manager] Cannot determine RAM for ${WORKER_SCRIPT}. Did you save it?`);
        return;
    }

    const incomePerThreadPerSec = await estimateThreadIncome(ns, cfg);
    if (!isFinite(incomePerThreadPerSec) || incomePerThreadPerSec <= 0) {
        ns.print("[pserv-manager] incomePerThreadPerSec <= 0; skipping ROI decisions.");
        return;
    }

    const owned = ns.getPurchasedServers();
    const prefix = cfg.hostnamePrefix;

    const candidates = [];

    // Candidate type 1: Buy a new server (if under cap).
    if (owned.length < cfg.maxServers) {
        const bestRam = bestRamWithinBudget(ns, budget, cfg.baseRam, maxTargetRam);
        if (bestRam > 0) {
            const cost = ns.getPurchasedServerCost(bestRam);
            const threads = Math.floor(bestRam / scriptRam);
            const deltaThreads = threads; // from 0 -> threads

            addCandidate(candidates, {
                type: "buy-new",
                hostname: `${prefix}${nextServerIndex(owned, prefix)}`,
                oldRam: 0,
                newRam: bestRam,
                deltaThreads,
                cost,
                incomePerThreadPerSec,
                cfg
            });
        }
    }

    // Candidate type 2: Replace weakest server when at cap.
    if (owned.length >= cfg.maxServers && owned.length > 0) {
        const fleetInfo = owned.map(h => ({
            hostname: h,
            ram: ns.getServerMaxRam(h),
        }));
        fleetInfo.sort((a, b) => a.ram - b.ram);
        const weakest = fleetInfo[0];

        // Find the best RAM tier strictly larger than weakest within budget.
        const bestUpgradeRam = bestRamWithinBudget(ns, budget, weakest.ram * 2, maxTargetRam);
        if (bestUpgradeRam > weakest.ram) {
            const cost = ns.getPurchasedServerCost(bestUpgradeRam);
            const oldThreads = Math.floor(weakest.ram / scriptRam);
            const newThreads = Math.floor(bestUpgradeRam / scriptRam);
            const deltaThreads = newThreads - oldThreads;

            addCandidate(candidates, {
                type: "upgrade-existing",
                hostname: weakest.hostname,
                oldRam: weakest.ram,
                newRam: bestUpgradeRam,
                deltaThreads,
                cost,
                incomePerThreadPerSec,
                cfg
            });
        }
    }

    if (candidates.length === 0) {
        ns.print("[pserv-manager] No ROI-positive candidates within budget.");
        return;
    }

    // Pick candidate with smallest paybackSeconds.
    candidates.sort((a, b) => a.paybackSeconds - b.paybackSeconds);
    const best = candidates[0];

    if (best.paybackSeconds > cfg.roiMaxPaybackSeconds) {
        ns.print(
            `[pserv-manager] Best payback ${best.paybackSeconds.toFixed(0)}s` +
            ` exceeds roiMaxPaybackSeconds=${cfg.roiMaxPaybackSeconds}. Skipping.`
        );
        return;
    }

    const paybackStr = ns.tFormat(best.paybackSeconds * 1000);
    const costStr = ns.nFormat(best.cost, "$0.000a");

    if (best.type === "buy-new") {
        const res = ns.purchaseServer(best.hostname, best.newRam);
        if (!res) {
            ns.print("[pserv-manager] purchaseServer() failed; maybe money moved.");
            return;
        }
        ns.tprint(
            `[pserv-manager] BUY ${best.hostname} (${best.newRam} GB)` +
            ` for ${costStr} | Δthreads=${best.deltaThreads}` +
            ` | payback≈${paybackStr}`
        );
        return;
    }

    if (best.type === "upgrade-existing") {
        ns.tprint(
            `[pserv-manager] UPGRADE ${best.hostname}: ${best.oldRam} GB -> ${best.newRam} GB` +
            ` for ${costStr} | Δthreads=${best.deltaThreads}` +
            ` | payback≈${paybackStr}`
        );

        // 1) kill everything on the host
        const killedOk = await killAllOnHost(ns, best.hostname, 8000);
        if (!killedOk) {
            ns.print(`[pserv-manager] Warning: couldn't fully kill scripts on ${best.hostname}; aborting upgrade.`);
            return;
        }

        // 2) attempt delete with retries
        let deleted = false;
        for (let attempt = 0; attempt < 6; attempt++) {
            if (ns.deleteServer(best.hostname)) {
                deleted = true;
                break;
            }
            ns.print(`[pserv-manager] deleteServer failed on attempt ${attempt+1}; retrying...`);
            await ns.sleep(500 + attempt * 200);
        }
        if (!deleted) {
            ns.print(`[pserv-manager] deleteServer(${best.hostname}) failed after retries; aborting.`);
            return;
        }

        // 3) ensure hostname is free in purchased list (safety)
        await ns.sleep(200); // tiny delay for the runtime to update lists

        // 4) Purchase the new server
        const purchased = ns.purchaseServer(best.hostname, best.newRam);
        if (!purchased) {
            ns.print("[pserv-manager] purchaseServer() failed after delete; aborting.");
            return;
        }
        ns.tprint(`[pserv-manager] Successfully purchased ${best.hostname} (${best.newRam} GB).`);

        ns.tprint(
            `[pserv-manager] Replaced ${best.hostname} with ${best.newRam} GB.` +
            " Re-run bin/start.js to redeploy hacking if needed."
        );
    }
}

/**
 * Estimate expected income per thread per second on the best money target.
 *
 * We approximate as:
 *   moneyPerHack = maxMoney * hackPercent * hackChance
 *   incomePerThreadPerSec = moneyPerHack / hackTime * roiFudgeFactor
 *
 * That assumes a mostly-hack loop; roiFudgeFactor lets you dial it down to
 * account for grow/weaken time and inefficiencies.
 */
async function estimateThreadIncome(ns, cfg) {
    const formulas = ns.formulas.hacking;
    const player = ns.getPlayer();

    const best = await getBestTarget(ns, "money");
    if (!best) {
        ns.print("[pserv-manager] No targets in targets.json; falling back to default income estimate.");
        // Very rough fallback; you can adjust this if you want.
        return 1_000;
    }

    ns.tprint(`Best target for income estimation: ${best.host}`);
    const server = ns.getServer(best.host);
    server.hackDifficulty = server.minDifficulty;
    ns.tprint(`server.hackDifficulty: ${server.hackDifficulty}`);

    const hackTime = formulas.hackTime(server, player);      // ms
    ns.tprint(`hackTime: ${hackTime} ms`);
    const hackChance = formulas.hackChance(server, player);  // 0–1
    ns.tprint(`hackChance: ${(hackChance * 100).toFixed(2)} %`);
    const hackPercent = formulas.hackPercent(server, player);// fraction of money per thread
    ns.tprint(`hackPercent: ${(hackPercent * 100).toFixed(4)} %`);
    const maxMoney = server.moneyMax || 0;
    ns.tprint(`maxMoney: ${ns.nFormat(maxMoney, "$0.000a")}`);

    if (!maxMoney || hackTime <= 0) return 0;

    const moneyPerHack = maxMoney * hackPercent * hackChance;
    ns.tprint(`moneyPerHack: ${ns.nFormat(moneyPerHack, "$0.000a")}`);
    const moneyPerSecPureHack = moneyPerHack / (hackTime / 1000);
    ns.tprint(`moneyPerSecPureHack: ${ns.nFormat(moneyPerSecPureHack, "$0.000a")}`);

    const fudge = cfg.roiFudgeFactor ?? 0.5;
    const income = moneyPerSecPureHack * fudge;

    ns.tprint(
        `[pserv-manager] Estimated income/thread/sec on ${best.host} ≈` +
        ` ${ns.nFormat(income, "$0.000a")} (fudge=${fudge})`
    );

    return income;
}

/**
 * Add a candidate and compute paybackSeconds, filtering out tiny upgrades.
 */
function addCandidate(list, base) {
    const {
        type,
        hostname,
        oldRam,
        newRam,
        deltaThreads,
        cost,
        incomePerThreadPerSec,
        cfg
    } = base;

    if (deltaThreads < (cfg.roiMinDeltaThreads ?? 1)) {
        return;
    }

    const deltaIncomePerSec = deltaThreads * incomePerThreadPerSec;
    if (!isFinite(deltaIncomePerSec) || deltaIncomePerSec <= 0) return;

    const paybackSeconds = cost / deltaIncomePerSec;
    if (!isFinite(paybackSeconds) || paybackSeconds <= 0) return;

    list.push({
        type,
        hostname,
        oldRam,
        newRam,
        deltaThreads,
        cost,
        paybackSeconds
    });
}

/**
 * Return the largest power-of-two RAM value in [minRam, maxRam] whose cost <= budget.
 * Returns 0 if none fit.
 *
 * @param {NS} ns
 * @param {number} budget
 * @param {number} minRam
 * @param {number} maxRam
 */
function bestRamWithinBudget(ns, budget, minRam, maxRam) {
    let ram = clampToPowerOfTwo(minRam);
    const max = clampToPowerOfTwo(maxRam);

    if (ram > max) return 0;

    let best = 0;
    while (ram <= max) {
        const cost = ns.getPurchasedServerCost(ram);
        if (cost > budget) break;
        best = ram;
        ram *= 2;
    }
    return best;
}

/** Round up to the next power of two (minimum of 1). */
function clampToPowerOfTwo(x) {
    x = Math.max(1, Math.floor(x));
    let p = 1;
    while (p < x) p <<= 1;
    return p;
}

/** Kill all scripts on a given host, and wait until they are gone.
 *  It then polls until ns.ps(host) is empty (or until `timeoutMs`).
 *  Returns true if successful, false if timeout reached.
 *  @param {NS} ns
 *  @param {string} hostname
 *  @param {number} timeoutMs
 */
async function killAllOnHost(ns, hostname, timeoutMs = 5000) {
    const anyKilled = ns.killall(hostname);

    // Wait until ps is empty or timeout
    if (anyKilled) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const remaining = ns.ps(hostname);
            if (!remaining || remaining.length === 0) return true;
            await ns.sleep(200);
        }
    }
    // Return whether host is now free of scripts
    return (ns.ps(hostname) || []).length === 0;
}


/**
 * Find the next numeric index to use for a new pserv name like "pserv-3".
 */
function nextServerIndex(owned, prefix) {
    const used = new Set(
        owned
            .filter(h => h.startsWith(prefix))
            .map(h => Number(h.slice(prefix.length)))
            .filter(n => Number.isFinite(n) && n >= 0)
    );

    let i = 0;
    while (used.has(i)) i++;
    return i;
}
