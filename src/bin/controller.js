import { readJSON, writeJSON } from "/lib/ns-io";
import { checkFactionServers } from "/scripts/singularity/check-faction-servers";
import { getDarkwebPrograms } from "/scripts/singularity/darkweb-programs.js";
import { makeStockManager } from "/lib/stockManager.js";

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog("ALL");
    //ns.enableLog("run");
    ns.tail();

    const CFG = {
        tickMs: 2000,

        // ---- Your existing stuff ----
        scanScore: "bin/scan-score.js",
        targetsFile: "data/targets.json",
        scanEveryMs: 5 * 60 * 1000,

        hgwOrchestrator: "scripts/hgw/orchestrator.js",
        batchOrchestrator: "scripts/batch/orchestrator.js",
        xpDeploy: "scripts/xp/deploy.js",
        gangManager: "scripts/gang/manager.js",
        pservManager: "scripts/pserv-manager.js",

        enableGangManager: false,
        enablePservManager: true,

        batchFromHacking: 800,
        targetSwitchMinImprovement: 1.15,

        // ---- Singularity syscalls ----
        data_dir: "data/singularity",

        checkDarkwebEveryMs: 5 * 60 * 1000,
        checkFactionServersEveryMs: 5 * 60 * 1000,
        joinInvitesEveryMs: 5 * 60 * 1000,
        workFactionEveryMs: 60 * 1000,
        ownedAugsEveryMs: 60 * 1000,

        // Aug pipeline scheduling
        augsFromFactionEveryMs: 5 * 60 * 1000,
        factionRepEveryMs: 30 * 1000,

        // Probing cadence
        augProbeEveryMs: 1500,   // 40GB calls (price/rep)
        augStatsEveryMs: 3500,   // 80GB calls
        augPrereqEveryMs: 3500,  // (likely 80GB depending on API)
        augBuyCooldownMs: 2500,

        // "Reach" gating to avoid wasting 80GB stats calls on far-away augs
        repReachBuffer: 25_000,

        // Buying policy
        maxAugSpendFraction: 0.35,
        minCashReserve: 5e8, // 500M

        // Keep cache bounded
        maxAugFactsCache: 75,

        // Rep grind (pick one faction)
        factionPriority: [
            //"Sector-12",
            //"CyberSec",
            //"NiteSec",
            //"The Black Hand",
            //"BitRunners",
            //"Tian Di Hui",
            "Daedalus",
            "Aevum",
            "Volhaven",
            "Chongqing",
            "New Tokyo",
            "Ishima",
        ],
        factionWorkType: "hacking",

        // Install policy
        installCooldownMs: 10 * 60 * 1000,
        minPendingAugs: 8,

        enableDonations: false,
    };

    const dataPath = {
        owned: `${CFG.data_dir}/owned-augs.json`,
        invites: `${CFG.data_dir}/invites.json`,
        joinOut: `${CFG.data_dir}/join-faction.json`,

        augsFaction: `${CFG.data_dir}/augs-from-faction.json`,
        factionRep: `${CFG.data_dir}/faction-rep.json`,

        augPrice: `${CFG.data_dir}/aug-price.json`,
        augRep: `${CFG.data_dir}/aug-rep.json`,
        augStats: `${CFG.data_dir}/aug-stats.json`,
        augReqs: `${CFG.data_dir}/aug-prereqs.json`,

        buy: `${CFG.data_dir}/purchase-aug.json`,

        install: `${CFG.data_dir}/install.json`,
        work: `${CFG.data_dir}/work-faction.json`,
    };

    const ctrl = {
        lastScanTs: 0,
        lastMode: null,
        lastTarget: null,
        lastTargetScore: 0,
        lastTargetApplied: null,

        // syscall scheduling
        syscallPid: 0,
        syscallKey: null,

        lastDarkwebCheckTs: 0,
        lastFactionServersCheckTs: 0,
        lastJoinInvitesTs: 0,
        lastOwnedAugsTs: 0,
        lastInstallTs: 0,
        lastWorkFactionTs: 0,
        lastAugsFromFactionTs: 0,
        lastFactionRepTs: 0,

        lastAugProbeTs: 0,
        lastAugStatsTs: 0,
        lastAugPrereqTs: 0,
        lastAugBuyTs: 0,

        // cached state
        pendingAugsCount: 0,
        chosenFaction: null,
        factionRep: 0,

        invites: [],

        augsFromFaction: [],
        augCandidates: [],

        // augFacts[aug] = { price?, repReq?, stats?, prereqs? }
        augFacts: {},

        // pendingPurchase = { faction, aug }
        pendingPurchase: null,

        ensureBackoff: {},

        statusMessages: [],
    };

    const stockMgr = makeStockManager({
        rebalanceMs: 6000,
        cooldownMs: 20000,
        maxOpenSymbols: 8,
        maxSymbolFrac: 0.10,
    });
    await stockMgr.init(ns, ctrl);

    // Ensure results dir exists (write a noop file)
    ns.write(`${CFG.data_dir}/keep.json`, "ok", "w");

    while (true) {
        const now = Date.now();
        const hack = ns.getHackingLevel();
        const formulas = ns.fileExists("Formulas.exe", "home");

        // ---- Hacking workload ----
        const best = await pickBestTarget(ns, CFG, hack);
        const chosen = chooseStickyTarget(ns, CFG, ctrl, hack, best);
        const target = chosen?.host ?? "n00dles";
        const mode = pickMoneyFirstMode(hack, CFG.batchFromHacking, formulas);

        tick: {

            await stockMgr.tick(ns, ctrl, now);

            // Keep gang manager alive
            if (CFG.enableGangManager) {
                ensureOnce(ns, ctrl, CFG.gangManager);
            }

            // Keep pserv manager alive
            if (CFG.enablePservManager) {
                ensureOnce(ns, ctrl, CFG.pservManager);
            }

            // Refresh targets.json periodically (but don't let scan-score starve syscall starts)
            const syscallBackoffActive = Object.entries(ctrl.ensureBackoff)
                .some(([k, t]) => k.startsWith("syscall:") && Date.now() < t);

            if (!syscallBackoffActive &&
                ns.fileExists(CFG.scanScore, "home") &&
                now - ctrl.lastScanTs > CFG.scanEveryMs &&
                !ns.isRunning(CFG.scanScore, "home")) {
                ns.run(CFG.scanScore, 1);
                ctrl.lastScanTs = now;
            }

            // Hacking workload
            reconcileWorkload(ns, CFG, ctrl, mode, target);
            ensureDesiredRunning(ns, CFG, ctrl, mode, target, formulas);

            // ---- Singularity syscalls (one at a time) ----
            if (ctrl.syscallPid !== 0 && ns.isRunning(ctrl.syscallPid)) {
                // still running
            } else {
                ctrl.syscallPid = 0;

                // Decide faction first
                ctrl.chosenFaction = pickFactionToWork(ns, CFG);

                // Apply results from previous probes (cheap reads)
                {
                    const repObj = await readJSON(ns, dataPath.factionRep);
                    if (repObj?.faction === ctrl.chosenFaction) {
                        ctrl.factionRep = clampNumber(repObj.rep, ctrl.factionRep ?? 0);
                    }

                    const priceObj = await readJSON(ns, dataPath.augPrice);
                    if (priceObj?.ok && priceObj?.aug) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[priceObj.aug] ??= {};
                        ctrl.augFacts[priceObj.aug].price = clampNumber(priceObj.price, undefined);
                    }

                    const repReqObj = await readJSON(ns, dataPath.augRep);
                    if (repReqObj?.ok && repReqObj?.aug) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[repReqObj.aug] ??= {};
                        ctrl.augFacts[repReqObj.aug].repReq = clampNumber(repReqObj.repReq, undefined);
                    }

                    const statsObj = await readJSON(ns, dataPath.augStats);
                    if (statsObj?.ok && statsObj?.aug && statsObj?.stats) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[statsObj.aug] ??= {};
                        ctrl.augFacts[statsObj.aug].stats = statsObj.stats;
                    }

                    const reqsObj = await readJSON(ns, dataPath.augReqs);
                    if (reqsObj?.ok && reqsObj?.aug && Array.isArray(reqsObj?.prereqs)) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[reqsObj.aug] ??= {};
                        ctrl.augFacts[reqsObj.aug].prereqs = reqsObj.prereqs.slice();
                    }
                }

                // Darkweb syscalls
                if (now - ctrl.lastDarkwebCheckTs > CFG.checkDarkwebEveryMs) {
                    if (!ns.hasTorRouter()) {
                        const key = "syscall:tor";
                        const pid = trySyscall(ns, ctrl, key, "scripts/singularity/purchase-tor.js", [], 1000);
                        if (pid !== 0) {
                            ctrl.syscallPid = pid;
                            ctrl.syscallKey = key;
                        }
                    }
                    else {
                        await getDarkwebPrograms(ns);
                    }
                    ctrl.lastDarkwebCheckTs = now;
                    ctrl.statusMessages.push(new Date(ctrl.lastDarkwebCheckTs).toLocaleString() + ": Checked darkweb programs");
                    await ns.sleep(CFG.tickMs);
                    continue;
                }

                // Faction servers syscall
                if (now - ctrl.lastFactionServersCheckTs > CFG.checkFactionServersEveryMs) {
                    await checkFactionServers(ns);
                    ctrl.lastFactionServersCheckTs = now;
                    ctrl.statusMessages.push(new Date(ctrl.lastFactionServersCheckTs).toLocaleString() + ": Checked faction servers");
                    await ns.sleep(CFG.tickMs);
                    continue;
                }

                // (A) Check invites periodically
                if (now - ctrl.lastJoinInvitesTs > CFG.joinInvitesEveryMs) {
                    const key = "syscall:inv";
                    const pid = trySyscall(ns, ctrl, key, "scripts/singularity/check-invites.js", [dataPath.invites], 1000);
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastJoinInvitesTs = now;
                        ctrl.statusMessages.push(new Date(ctrl.lastJoinInvitesTs).toLocaleString() + ": Checked faction invites");
                        await ns.sleep(CFG.tickMs);
                        continue;
                    }
                }

                // (B) Join one invite if present
                ctrl.invites = await readInvites(ns, dataPath.invites, ctrl.invites);
                if (ctrl.invites?.length) {
                    const nextFaction = ctrl.invites[0];
                    const key = "syscall:jf";
                    const pid = trySyscall(ns, ctrl, key, "scripts/singularity/join-faction.js", [nextFaction, dataPath.joinOut], 1000);
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.invites.shift();
                        writeJSON(ns, dataPath.invites, { ts: Date.now(), invites: ctrl.invites });
                        ctrl.statusMessages.push(new Date().toLocaleString() + `: Joined faction ${nextFaction}`);
                        await ns.sleep(CFG.tickMs);
                        continue;
                    }
                }

                // (C) Refresh owned augs periodically
                if (now - ctrl.lastOwnedAugsTs > CFG.ownedAugsEveryMs) {
                    const key = "syscall:own";
                    const pid = trySyscall(ns, ctrl, key, "scripts/singularity/get-owned-augs.js", [dataPath.owned], 1000);
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastOwnedAugsTs = now;
                        break tick;
                    }
                }

                // Read owned + pending count
                ctrl.pendingAugsCount = await readPendingCount(ns, dataPath.owned, ctrl.pendingAugsCount);
                const ownedObj = await readJSON(ns, dataPath.owned);
                const ownedList = Array.isArray(ownedObj?.owned) ? ownedObj.owned : [];
                const ownedSet = new Set(ownedList);

                // (D) Refresh faction rep periodically
                if (ctrl.chosenFaction && (now - ctrl.lastFactionRepTs > CFG.factionRepEveryMs)) {
                    const key = "syscall:rep";
                    const pid = trySyscall(ns, ctrl, key, "scripts/singularity/get-faction-rep.js", [ctrl.chosenFaction, dataPath.factionRep], 1000);
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastFactionRepTs = now;
                        break tick;
                    }
                }

                // (E) Refresh augs-from-faction occasionally
                if (ctrl.chosenFaction && (now - ctrl.lastAugsFromFactionTs > CFG.augsFromFactionEveryMs)) {
                    const key = "syscall:af";
                    const pid = trySyscall(ns, ctrl, key, "scripts/singularity/get-augs-from-faction.js", [ctrl.chosenFaction, dataPath.augsFaction], 1000);
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastAugsFromFactionTs = now;
                        break tick;
                    }
                }

                // Update cached augs list + candidates
                const augsObj = await readJSON(ns, dataPath.augsFaction);
                if (augsObj?.ok && augsObj?.faction === ctrl.chosenFaction && Array.isArray(augsObj?.augs)) {
                    ctrl.augsFromFaction = augsObj.augs.slice();
                    // all augs offered by chosen faction minus owned
                    ctrl.augCandidates = ctrl.augsFromFaction.filter(a => !ownedSet.has(a));

                    // keep cache bounded
                    pruneAugFacts(ctrl, new Set(ctrl.augCandidates), CFG.maxAugFactsCache);
                }

                // (F) Attempt pending purchase
                if (ctrl.pendingPurchase && (now - ctrl.lastAugBuyTs > CFG.augBuyCooldownMs)) {
                    const { faction, aug } = ctrl.pendingPurchase;
                    const key = "syscall:buy";
                    const pid = trySyscall(ns, ctrl, key, "scripts/singularity/purchase-aug.js", [faction, aug, dataPath.buy], 1500);
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastAugBuyTs = now;
                        ctrl.pendingPurchase = null;
                        break tick;
                    }
                }

                // (G) Probe missing facts and/or decide what to buy
                if (ctrl.augCandidates?.length) {
                    // 1) price/rep probes (40GB)
                    if (now - ctrl.lastAugProbeTs > CFG.augProbeEveryMs) {
                        const aug = ctrl.augCandidates.find(a => {
                            const f = ctrl.augFacts?.[a];
                            // need price or rep
                            return !f || !Number.isFinite(f.price) || !Number.isFinite(f.repReq);
                        });

                        if (aug) {
                            ctrl.augFacts ??= {};
                            ctrl.augFacts[aug] ??= {};
                            const f = ctrl.augFacts[aug];

                            let pid = 0;
                            let key = null;
                            if (!Number.isFinite(f.price)) {
                                key = "syscall:ap";
                                pid = trySyscall(ns, ctrl, key, "scripts/singularity/get-aug-price.js", [aug, dataPath.augPrice], 1000);
                            } else if (!Number.isFinite(f.repReq)) {
                                key = "syscall:ar";
                                pid = trySyscall(ns, ctrl, key, "scripts/singularity/get-aug-rep.js", [aug, dataPath.augRep], 1000);
                            }

                            if (pid !== 0) {
                                ctrl.syscallPid = pid;
                                ctrl.syscallKey = key;
                                ctrl.lastAugProbeTs = now;
                                break tick;
                            }
                        }
                    }

                    // 2) stats probe (80GB), gated by rep reach window
                    if (now - ctrl.lastAugStatsTs > CFG.augStatsEveryMs) {
                        const aug = ctrl.augCandidates.find(a => {
                            const f = ctrl.augFacts?.[a];
                            if (!f) return false;
                            if (!Number.isFinite(f.price) || !Number.isFinite(f.repReq)) return false;
                            if (f.stats) return false;
                            // only bother if close to reach
                            const rep = ctrl.factionRep ?? 0;
                            return f.repReq <= rep + CFG.repReachBuffer;
                        });

                        if (aug) {
                            const key = "syscall:as";
                            const pid = trySyscall(ns, ctrl, key, "scripts/singularity/get-aug-stats.js", [aug, dataPath.augStats], 1500);
                            if (pid !== 0) {
                                ctrl.syscallPid = pid;
                                ctrl.syscallKey = key;
                                ctrl.lastAugStatsTs = now;
                                break tick;
                            }
                        }
                    }

                    // 3) prereq probe (useful, but can be expensive), also gated
                    if (now - ctrl.lastAugPrereqTs > CFG.augPrereqEveryMs) {
                        const aug = ctrl.augCandidates.find(a => {
                            const f = ctrl.augFacts?.[a];
                            if (!f) return false;
                            if (!Number.isFinite(f.price) || !Number.isFinite(f.repReq)) return false;
                            if (f.prereqs) return false;
                            // if not close to reach, skip
                            const rep = ctrl.factionRep ?? 0;
                            return f.repReq <= rep + CFG.repReachBuffer;
                        });

                        if (aug) {
                            const key = "syscall:aq";
                            const pid = trySyscall(ns, ctrl, key, "scripts/singularity/get-aug-prereqs.js", [aug, dataPath.augReqs], 1500);
                            if (pid !== 0) {
                                ctrl.syscallPid = pid;
                                ctrl.syscallKey = key;
                                ctrl.lastAugPrereqTs = now;
                                break tick;
                            }
                        }
                    }

                    // 4) Decide best buy using ROI (hacking + charisma) and prereq closure
                    // Only consider candidates with full facts (price/rep/stats/prereqs)
                    const cash = ns.getPlayer().money;
                    const spendCap = Math.max(0, cash * CFG.maxAugSpendFraction);
                    const reserve = CFG.minCashReserve;
                    const repNow = ctrl.factionRep ?? 0;

                    // Build scored list
                    const scored = ctrl.augCandidates
                        .map(aug => {
                            const f = ctrl.augFacts?.[aug];
                            if (!f) return null;
                            if (!Number.isFinite(f.price) || !Number.isFinite(f.repReq) || !f.stats || !Array.isArray(f.prereqs)) return null;
                            const missing = firstMissingPrereq(f.prereqs, ownedSet);
                            const roi = augRoiScore(f.stats, f.price);
                            return { aug, price: f.price, repReq: f.repReq, roi, missing };
                        })
                        .filter(Boolean)
                        .sort((a, b) => b.roi - a.roi);

                    // Pick best aug; if it has missing prereq, try to buy the prereq first
                    let desired = scored[0] ?? null;
                    if (desired?.missing) {
                        // promote prereq to purchase target IF it exists in our candidate list
                        const prereq = desired.missing;
                        const pf = ctrl.augFacts?.[prereq];

                        // If we don't even know enough about prereq, it'll get picked up by probe steps above.
                        if (pf && Number.isFinite(pf.price) && Number.isFinite(pf.repReq) && pf.stats && Array.isArray(pf.prereqs)) {
                            desired = {
                                aug: prereq,
                                price: pf.price,
                                repReq: pf.repReq,
                                roi: augRoiScore(pf.stats, pf.price),
                                missing: firstMissingPrereq(pf.prereqs, ownedSet),
                            };
                        } else {
                            // ensure prereq is in our augCandidates if the faction offers it
                            // (if not, we can't solve it here; you'll need a multi-faction planner later)
                        }
                    }

                    if (desired &&
                        desired.repReq <= repNow &&
                        desired.price <= spendCap &&
                        (cash - desired.price) >= reserve &&
                        !desired.missing) {
                        if (ctrl.chosenFaction) {
                            ctrl.pendingPurchase = { faction: ctrl.chosenFaction, aug: desired.aug };
                        }
                    }
                }

                // (H) Install if enough pending augs and cooldown elapsed
                const canInstall =
                    ctrl.pendingAugsCount >= CFG.minPendingAugs &&
                    (now - ctrl.lastInstallTs) > CFG.installCooldownMs;

                if (canInstall) {
                    const key = "syscall:ins";
                    const pid = trySyscall(ns, ctrl, key, "scripts/singularity/install.js", ["bootstrap.js", dataPath.install], 2000);
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastInstallTs = now;
                        break tick;
                    }
                }

                // (I) keep working for faction
                if (ctrl.chosenFaction && (now - ctrl.lastWorkFactionTs > CFG.workFactionEveryMs)) {
                    const key = "syscall:wk";
                    const pid = trySyscall(
                        ns, ctrl,
                        key,
                        "scripts/singularity/work-faction.js",
                        [ctrl.chosenFaction, CFG.factionWorkType, false, dataPath.work],
                        1000
                    );
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastWorkFactionTs = now;
                    }
                }
            }
        };
        await drawUI(ns, CFG, ctrl, best, mode, target, hack, formulas);
        await ns.sleep(CFG.tickMs);
    }
}

// Draw controller UI
async function drawUI(ns, CFG, ctrl, best, mode, target, hack, formulas, stockMgr) {
    ns.clearLog();

    ns.print(`Mode: ${mode} | Target: ${target}`);
    if (best) ns.print(`BestNow: ${best.host} (${best.score.toFixed(2)}) | Sticky: ${ctrl.lastTarget} (${(ctrl.lastTargetScore || 0).toFixed(2)})`);

    ns.print(`Hack: ${hack} | Formulas.exe: ${formulas ? "YES" : "NO"}`);

    const free = freeRam(ns, "home");
    ns.print(`Home RAM: free=${free.toFixed(1)}GB`);

    ns.print(`Faction: ${ctrl.chosenFaction ?? "(none)"} | Rep: ${Math.floor(ctrl.factionRep ?? 0)}`);
    ns.print(`PendingAugs: ${ctrl.pendingAugsCount} | InstallCD: ${Math.max(0, Math.floor((CFG.installCooldownMs - (Date.now() - ctrl.lastInstallTs)) / 1000))}s`);

    ns.print(`Syscall: ${ctrl.syscallPid ? `PID ${ctrl.syscallPid} (${ctrl.syscallKey})` : "idle"}`);
    ns.print(`scan-score: ${ns.isRunning(CFG.scanScore, "home") ? "RUNNING" : "idle"}`);

    if (ctrl.pendingPurchase) {
        ns.print(`PendingPurchase: ${ctrl.pendingPurchase.aug} @ ${ctrl.pendingPurchase.faction}`);
    }

    for (const line of stockMgr.status(ctrl)) ns.print(line);

    if (ctrl.statusMessages?.length) {
        // keep last few messages
        ctrl.statusMessages = ctrl.statusMessages.slice(-8);
        ns.print("--- status ---");
        for (const m of ctrl.statusMessages) ns.print(m);
    }
}

// Log syscall run failure with RAM and running scripts info
function logSyscallRunFail(ns, ctrl, script) {
    const free = freeRam(ns, "home");
    const reqRam = ns.getScriptRam(script, "home");
    const runningScripts = ns.ps("home").map(s => s.filename).join(", ");
    const message = `Syscall failed (${script}) freeRam=${free.toFixed(1)}GB reqRam=${reqRam.toFixed(1)}GB running=${runningScripts}`;
    ctrl.statusMessages.push(message);
}

// Return free RAM on host
function freeRam(ns, host = "home") {
    return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}

/* ---------------- Workload logic ---------------- */

// Decide workload mode based on hack level and formulas presence
function pickMoneyFirstMode(hackLevel, batchFromHacking, formulas) {
    if (hackLevel >= batchFromHacking) return formulas ? "BATCH" : "HGW";
    return "HGW";
}

// Reconcile workload scripts based on desired mode/target
function reconcileWorkload(ns, CFG, ctrl, mode, target) {
    const changed = (ctrl.lastMode !== mode) || (ctrl.lastTargetApplied !== target);
    if (!changed) return;

    kill(ns, CFG.hgwOrchestrator);
    kill(ns, CFG.batchOrchestrator);
    kill(ns, CFG.xpDeploy);

    ctrl.lastMode = mode;
    ctrl.lastTargetApplied = target;

    ctrl.ensureBackoff = {};
}

// Ensure desired workload script is running
function ensureDesiredRunning(ns, CFG, ctrl, mode, target, formulas) {
    if (mode === "HGW") {
        ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [target]);
    } else if (mode === "BATCH") {
        if (formulas) ensureOnce(ns, ctrl, CFG.batchOrchestrator);
        else ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [target]);
    } else if (mode === "XP") {
        ensureOnce(ns, ctrl, CFG.xpDeploy);
    }
}

// Ensure a script is running once with args, with backoff on failure
function ensureOnce(ns, ctrl, script, args = [], retryMs = 500) {
    if (!ns.fileExists(script, "home")) return;

    const key = `${script} ${JSON.stringify(args)}`;
    const now = Date.now();
    const nextOk = ctrl.ensureBackoff?.[key] ?? 0;
    if (now < nextOk) return;

    if (ns.isRunning(script, "home", ...args)) {
        delete ctrl.ensureBackoff[key];
        return;
    }

    const pid = ns.run(script, 1, ...args);
    if (pid === 0) {
        ctrl.ensureBackoff[key] = now + retryMs;
    } else {
        delete ctrl.ensureBackoff[key];
    }
}

// Try to run a syscall script, with backoff on failure
function trySyscall(ns, ctrl, key, script, args = [], retryMs = 1000) {
    if (!ns.fileExists(script, "home")) {
        ctrl.statusMessages.push(`Syscall failed: missing script ${script}`);
        return 0;
    }

    const now = Date.now();
    const nextOk = ctrl.ensureBackoff?.[key] ?? 0;
    if (now < nextOk) {
        ctrl.statusMessages.push(`Syscall backoff active for ${script}`);
        return 0;
    }

    const pid = ns.run(script, 1, ...args);
    if (pid === 0) {
        ctrl.ensureBackoff[key] = now + retryMs;
        logSyscallRunFail(ns, ctrl, script);
        return 0;
    }

    delete ctrl.ensureBackoff[key];
    return pid;
}

// Kill a script if running
function kill(ns, script) {
    if (ns.fileExists(script, "home") && ns.isRunning(script, "home")) ns.kill(script, "home");
}

/* ---------------- Targeting ---------------- */

// Pick best target from targets.json
async function pickBestTarget(ns, CFG, hackLevel) {
    if (!ns.fileExists(CFG.targetsFile, "home")) return null;
    try {
        const rows = await readJSON(ns, CFG.targetsFile);
        if (!Array.isArray(rows)) return null;
        const usable = rows
            .filter(r => r && typeof r.host === "string")
            .filter(r => ns.serverExists(r.host))
            .filter(r => ns.hasRootAccess(r.host))
            .filter(r => (r.reqHack ?? ns.getServerRequiredHackingLevel(r.host)) <= hackLevel)
            .filter(r => (r.maxMoney ?? ns.getServerMaxMoney(r.host)) > 0)
            .map(r => ({ host: r.host, score: Number(r.score ?? 0) }));
        usable.sort((a, b) => b.score - a.score);
        return usable[0] ?? null;
    } catch {
        return null;
    }
}

// Choose whether to stick to last target or switch to best target
function chooseStickyTarget(ns, CFG, ctrl, hackLevel, best) {
    const cur = ctrl.lastTarget;

    if (!best) return cur ? { host: cur, score: ctrl.lastTargetScore || 0 } : null;

    if (!cur) {
        ctrl.lastTarget = best.host;
        ctrl.lastTargetScore = best.score;
        return best;
    }

    if (!isValid(ns, cur, hackLevel)) {
        ctrl.lastTarget = best.host;
        ctrl.lastTargetScore = best.score;
        return best;
    }

    const curScore = ctrl.lastTargetScore || 0;
    if (curScore <= 0) {
        ctrl.lastTarget = best.host;
        ctrl.lastTargetScore = best.score;
        return best;
    }

    if (best.host !== cur && best.score >= curScore * CFG.targetSwitchMinImprovement) {
        ctrl.lastTarget = best.host;
        ctrl.lastTargetScore = best.score;
        return best;
    }

    return { host: cur, score: curScore };
}

// Check if target is valid for hacking
function isValid(ns, host, hackLevel) {
    return ns.serverExists(host)
        && ns.hasRootAccess(host)
        && ns.getServerMaxMoney(host) > 0
        && ns.getServerRequiredHackingLevel(host) <= hackLevel;
}

/* ---------------- Singularity helpers (controller-side, no singularity API) ---------------- */

// Pick faction to work for based on priority list
function pickFactionToWork(ns, CFG) {
    const factions = ns.getPlayer().factions ?? [];
    for (const f of CFG.factionPriority) if (factions.includes(f)) return f;
    return factions[0] ?? null;
}

// Read pending aug count
async function readPendingCount(ns, path, fallback) {
    try {
        const obj = await readJSON(ns, path);
        if (typeof obj?.pendingCount === "number") return obj.pendingCount;
        if (Array.isArray(obj?.pending)) return obj.pending.length;
        return fallback;
    } catch {
        return fallback;
    }
}

// Read invites list
async function readInvites(ns, path, fallback) {
    try {
        const obj = await readJSON(ns, path);
        if (Array.isArray(obj?.invites)) return obj.invites.slice();
        return fallback;
    } catch {
        return fallback;
    }
}

// Clamp to number or fallback
function clampNumber(x, fallback = 0) {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
}

// Keep only aug facts for a set of augs, up to a max count
function pruneAugFacts(ctrl, keepSet, maxKeep) {
    if (!ctrl.augFacts) ctrl.augFacts = {};
    const keys = Object.keys(ctrl.augFacts);
    if (keys.length <= maxKeep) return;

    for (const k of keys) {
        if (!keepSet.has(k)) delete ctrl.augFacts[k];
        if (Object.keys(ctrl.augFacts).length <= maxKeep) break;
    }
}

// Return first missing prereq from ownedSet, or null if all satisfied
function firstMissingPrereq(prereqs, ownedSet) {
    if (!Array.isArray(prereqs)) return null;
    for (const p of prereqs) if (!ownedSet.has(p)) return p;
    return null;
}

// Aug value function (hacking + charisma multipliers)
function mult(stats, key) {
    const v = stats?.[key];
    return (typeof v === "number" && Number.isFinite(v)) ? v : 1;
}

// Return value score for aug based on hacking + charisma multipliers
function augValueHackCha(stats) {
    if (!stats) return 0;

    const hacking =
        4.0 * (mult(stats, "hacking_mult") - 1) +
        3.0 * (mult(stats, "hacking_exp_mult") - 1) +
        2.0 * (mult(stats, "hacking_speed_mult") - 1) +
        1.5 * (mult(stats, "hacking_chance_mult") - 1) +
        1.0 * (mult(stats, "hacking_money_mult") - 1) +
        0.5 * (mult(stats, "hacking_grow_mult") - 1);

    const charisma =
        1.5 * (mult(stats, "charisma_mult") - 1) +
        1.0 * (mult(stats, "charisma_exp_mult") - 1);

    return Math.max(0, hacking + charisma);
}

// Return ROI score for aug based on hacking + charisma value divided by price
function augRoiScore(stats, price) {
    const v = augValueHackCha(stats);
    if (!Number.isFinite(price) || price <= 0) return 0;
    return v / price;
}
