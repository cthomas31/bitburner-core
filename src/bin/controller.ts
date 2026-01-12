import type { NS } from "@ns";
import { readJSON, writeJSON } from "/lib/ns-io";
import { checkFactionServers } from "/scripts/singularity/check-faction-servers";
import { getDarkwebPrograms } from "/scripts/singularity/darkweb-programs.js";
import { makeStockManager, StockManager, StockState } from "/lib/stockManager.js";

// ============== Type Definitions ==============

interface FactionChooserConfig {
    repCacheMs: number;
    augsCacheMs: number;
    repGapPenalty: number;
    buyNowBonus: number;
    crossFactionPrereqPenalty: number;
    cacheUpdateEveryMs?: number;
}

interface ControllerConfig {
    tickMs: number;

    // ---- Your existing stuff ----
    scanScore: string;
    targetsFile: string;
    scanEveryMs: number;

    hgwOrchestrator: string;
    batchOrchestrator: string;
    xpDeploy: string;
    gangManager: string;
    pservManager: string;

    enableGangManager: boolean;
    enablePservManager: boolean;

    batchFromHacking: number;
    targetSwitchMinImprovement: number;

    // ---- Singularity syscalls ----
    data_dir: string;

    checkDarkwebEveryMs: number;
    checkFactionServersEveryMs: number;
    joinInvitesEveryMs: number;
    workFactionEveryMs: number;
    ownedAugsEveryMs: number;

    // Aug pipeline scheduling
    augsFromFactionEveryMs: number;
    factionRepEveryMs: number;

    // Probing cadence
    augProbeEveryMs: number;
    augStatsEveryMs: number;
    augPrereqEveryMs: number;
    augBuyCooldownMs: number;

    // "Reach" gating to avoid wasting 80GB stats calls on far-away augs
    repReachBuffer: number;

    // Buying policy
    maxAugSpendFraction: number;
    minCashReserve: number;

    // Keep cache bounded
    maxAugFactsCache: number;

    // Rep grind (pick one faction)
    factionPriority: string[];
    factionWorkType: string;

    factionChooser: FactionChooserConfig;

    // Install policy
    installCooldownMs: number;
    minPendingAugs: number;

    enableDonations: boolean;
}

interface DataPaths {
    owned: string;
    invites: string;
    joinOut: string;
    augsFaction: string;
    factionRep: string;
    augPrice: string;
    augRep: string;
    augStats: string;
    augReqs: string;
    buy: string;
    install: string;
    work: string;
}

interface AugFacts {
    price?: number;
    repReq?: number;
    stats?: AugStats;
    prereqs?: string[];
}

interface AugStats {
    hacking_mult?: number;
    hacking_exp_mult?: number;
    hacking_speed_mult?: number;
    hacking_chance_mult?: number;
    hacking_money_mult?: number;
    hacking_grow_mult?: number;
    charisma_mult?: number;
    charisma_exp_mult?: number;
    [key: string]: number | undefined;
}

interface FactionCacheEntry {
    rep: number;
    ts: number;
}

interface FactionAugsCacheEntry {
    augs: string[];
    ts: number;
}

export interface ControllerState {
    lastScanTs: number;
    lastMode: string | null;
    lastTarget: string | null;
    lastTargetScore: number;
    lastTargetApplied: string | null;

    // syscall scheduling
    syscallPid: number;
    syscallKey: string | null;

    lastDarkwebCheckTs: number;
    lastFactionServersCheckTs: number;
    lastJoinInvitesTs: number;
    lastOwnedAugsTs: number;
    lastInstallTs: number;
    lastWorkFactionTs: number;
    lastAugsFromFactionTs: number;
    lastFactionRepTs: number;

    lastAugProbeTs: number;
    lastAugStatsTs: number;
    lastAugPrereqTs: number;
    lastAugBuyTs: number;

    // cached state
    pendingAugsCount: number;
    chosenFaction: string | null;
    factionRep: number;

    invites: string[];

    augsFromFaction: string[];
    augCandidates: string[];

    // augFacts[aug] = { price?, repReq?, stats?, prereqs? }
    augFacts: Record<string, AugFacts>;

    // Faction caches for smarter choosing
    factionRepCache: Record<string, FactionCacheEntry>;
    factionAugsCache: Record<string, FactionAugsCacheEntry>;
    factionCacheIndex: number;
    lastFactionCacheUpdateTs: number;

    // pendingPurchase = { faction, aug }
    pendingPurchase: { faction: string; aug: string } | null;

    ensureBackoff: Record<string, number>;

    statusMessages: string[];

    ownedSet?: Set<string>;

    stock?: StockState;
}

interface TargetEntry {
    host: string;
    score: number;
}

interface ScoredAug {
    aug: string;
    price: number;
    repReq: number;
    roi: number;
    missing: string | null;
}

// ============== Main Entry Point ==============

export async function main(ns: NS): Promise<void> {
    ns.disableLog("ALL");
    //ns.enableLog("run");
    ns.tail();

    const CFG: ControllerConfig = {
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

        factionChooser: {
            repCacheMs: 5 * 60 * 1000,
            augsCacheMs: 15 * 60 * 1000,
            repGapPenalty: 1.0,          // bigger = favors nearer goals
            buyNowBonus: 1e9,            // makes "can buy now" always win
            crossFactionPrereqPenalty: 0.25, // 0..1 multiplier
        },

        // Install policy
        installCooldownMs: 10 * 60 * 1000,
        minPendingAugs: 8,

        enableDonations: false,
    };

    const dataPath: DataPaths = {
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

    const ctrl: ControllerState = {
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

        // Faction caches for smarter choosing
        // factionRepCache[f]  = { rep, ts }
        // factionAugsCache[f] = { augs: [...], ts }
        factionRepCache: {},
        factionAugsCache: {},
        factionCacheIndex: 0,
        lastFactionCacheUpdateTs: 0,

        // pendingPurchase = { faction, aug }
        pendingPurchase: null,

        ensureBackoff: {},

        statusMessages: [],
    };

    const stockMgr: StockManager = makeStockManager({
        rebalanceMs: 6000,
        cooldownMs: 20000,
        maxOpenSymbols: 8,
        maxSymbolFrac: 0.10,
    });
    await stockMgr.init(ns, ctrl);

    // Ensure results dir exists (write a noop file)
    ns.write(`${CFG.data_dir}/keep.json`, "ok", "w");

    for (; ;) {
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


                // Apply results from previous probes (cheap reads)
                {
                    // Always update faction caches from whatever the last syscall wrote,
                    // even if it wasn't for the current chosenFaction.
                    await applyFactionCacheFromFiles(ns, ctrl, dataPath);

                    const repObj = await readJSON(ns, dataPath.factionRep) as { faction?: string; rep?: number } | null;
                    if (repObj?.faction === ctrl.chosenFaction) {
                        ctrl.factionRep = clampNumber(repObj.rep, ctrl.factionRep ?? 0);
                    }

                    const priceObj = await readJSON(ns, dataPath.augPrice) as { ok?: boolean; aug?: string; price?: number } | null;
                    if (priceObj?.ok && priceObj?.aug) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[priceObj.aug] ??= {};
                        ctrl.augFacts[priceObj.aug].price = clampNumber(priceObj.price, undefined);
                    }

                    const repReqObj = await readJSON(ns, dataPath.augRep) as { ok?: boolean; aug?: string; repReq?: number } | null;
                    if (repReqObj?.ok && repReqObj?.aug) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[repReqObj.aug] ??= {};
                        ctrl.augFacts[repReqObj.aug].repReq = clampNumber(repReqObj.repReq, undefined);
                    }

                    const statsObj = await readJSON(ns, dataPath.augStats) as { ok?: boolean; aug?: string; stats?: AugStats } | null;
                    if (statsObj?.ok && statsObj?.aug && statsObj?.stats) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[statsObj.aug] ??= {};
                        ctrl.augFacts[statsObj.aug].stats = statsObj.stats;
                    }

                    const reqsObj = await readJSON(ns, dataPath.augReqs) as { ok?: boolean; aug?: string; prereqs?: string[] } | null;
                    if (reqsObj?.ok && reqsObj?.aug && Array.isArray(reqsObj?.prereqs)) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[reqsObj.aug] ??= {};
                        ctrl.augFacts[reqsObj.aug].prereqs = reqsObj.prereqs.slice();
                    }
                }

                // Background cache upkeep: periodically refresh 1 faction (rep or aug list)
                // so smart chooser has data. This is intentionally gentle.
                {
                    const pid = maybeStartFactionCacheUpdate(ns, CFG, ctrl, now, dataPath);
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        // syscallKey is set inside helper
                        // IMPORTANT: break tick so the single drawUI call runs and we don't start other syscalls
                        break tick;
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
                    break tick;
                }

                // Faction servers syscall
                if (now - ctrl.lastFactionServersCheckTs > CFG.checkFactionServersEveryMs) {
                    await checkFactionServers(ns);
                    ctrl.lastFactionServersCheckTs = now;
                    ctrl.statusMessages.push(new Date(ctrl.lastFactionServersCheckTs).toLocaleString() + ": Checked faction servers");
                    break tick;
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
                        break tick;
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
                        break tick;
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
                const ownedObj = await readJSON(ns, dataPath.owned) as { owned?: string[] } | null;
                const rawOwned = ownedObj?.owned;
                const ownedList = Array.isArray(rawOwned) ? rawOwned : [];
                const ownedSet = new Set(ownedList);
                ctrl.ownedSet = ownedSet;

                // Decide faction AFTER we know what we own and AFTER caches can be updated.
                // Falls back to priority list until caches fill in.
                ctrl.chosenFaction = pickFactionToWorkSmart(ns, CFG, ctrl, ownedSet);

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
                const augsObj = await readJSON(ns, dataPath.augsFaction) as { ok?: boolean; faction?: string; augs?: string[] } | null;
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
                            let key: string | null = null;
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
                            return (f.repReq ?? 0) <= rep + CFG.repReachBuffer;
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
                            return (f.repReq ?? 0) <= rep + CFG.repReachBuffer;
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
                    const scored: ScoredAug[] = ctrl.augCandidates
                        .map(aug => {
                            const f = ctrl.augFacts?.[aug];
                            if (!f) return null;
                            if (!Number.isFinite(f.price) || !Number.isFinite(f.repReq) || !f.stats || !Array.isArray(f.prereqs)) return null;
                            const missing = firstMissingPrereq(f.prereqs, ownedSet);
                            const roi = augRoiScore(f.stats, f.price ?? 0);
                            return { aug, price: f.price ?? 0, repReq: f.repReq ?? 0, roi, missing };
                        })
                        .filter((x): x is ScoredAug => x !== null)
                        .sort((a, b) => b.roi - a.roi);

                    // Pick best aug; if it has missing prereq, try to buy the prereq first
                    let desired: ScoredAug | null = scored[0] ?? null;
                    if (desired?.missing) {
                        // promote prereq to purchase target IF it exists in our candidate list
                        const prereq = desired.missing;
                        const pf = ctrl.augFacts?.[prereq];

                        // If we don't even know enough about prereq, it'll get picked up by probe steps above.
                        if (pf && Number.isFinite(pf.price) && Number.isFinite(pf.repReq) && pf.stats && Array.isArray(pf.prereqs)) {
                            desired = {
                                aug: prereq,
                                price: pf.price ?? 0,
                                repReq: pf.repReq ?? 0,
                                roi: augRoiScore(pf.stats, pf.price ?? 0),
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
        }
        await drawUI(ns, CFG, ctrl, best, mode, target, hack, formulas, stockMgr);
        await ns.sleep(CFG.tickMs);
    }
}

// ============== UI Drawing ==============

// Draw controller UI
async function drawUI(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    best: TargetEntry | null,
    mode: string,
    target: string,
    hack: number,
    formulas: boolean,
    stockMgr: StockManager
): Promise<void> {
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

// ============== Logging Helpers ==============

// Log syscall run failure with RAM and running scripts info
function logSyscallRunFail(ns: NS, ctrl: ControllerState, script: string): void {
    const free = freeRam(ns, "home");
    const reqRam = ns.getScriptRam(script, "home");
    const runningScripts = ns.ps("home").map(s => s.filename).join(", ");
    const message = `Syscall failed (${script}) freeRam=${free.toFixed(1)}GB reqRam=${reqRam.toFixed(1)}GB running=${runningScripts}`;
    ctrl.statusMessages.push(message);
}

// Return free RAM on host
function freeRam(ns: NS, host = "home"): number {
    return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}

// ============== Workload Logic ==============

// Decide workload mode based on hack level and formulas presence
function pickMoneyFirstMode(hackLevel: number, batchFromHacking: number, formulas: boolean): string {
    if (hackLevel >= batchFromHacking) return formulas ? "BATCH" : "HGW";
    return "HGW";
}

// Reconcile workload scripts based on desired mode/target
function reconcileWorkload(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    mode: string,
    target: string
): void {
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
function ensureDesiredRunning(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    mode: string,
    target: string,
    formulas: boolean
): void {
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
function ensureOnce(
    ns: NS,
    ctrl: ControllerState,
    script: string,
    args: (string | number | boolean)[] = [],
    retryMs = 500
): void {
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
function trySyscall(
    ns: NS,
    ctrl: ControllerState,
    key: string,
    script: string,
    args: (string | number | boolean)[] = [],
    retryMs = 1000
): number {
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
function kill(ns: NS, script: string): void {
    if (ns.fileExists(script, "home") && ns.isRunning(script, "home")) ns.kill(script, "home");
}

// ============== Targeting ==============

// Pick best target from targets.json
async function pickBestTarget(
    ns: NS,
    CFG: ControllerConfig,
    hackLevel: number
): Promise<TargetEntry | null> {
    if (!ns.fileExists(CFG.targetsFile, "home")) return null;
    try {
        const rows = await readJSON(ns, CFG.targetsFile) as Array<{ host?: string; score?: number; reqHack?: number; maxMoney?: number }> | null;
        if (!Array.isArray(rows)) return null;
        const usable = rows
            .filter(r => r && typeof r.host === "string")
            .filter(r => ns.serverExists(r.host as string))
            .filter(r => ns.hasRootAccess(r.host as string))
            .filter(r => (r.reqHack ?? ns.getServerRequiredHackingLevel(r.host as string)) <= hackLevel)
            .filter(r => (r.maxMoney ?? ns.getServerMaxMoney(r.host as string)) > 0)
            .map(r => ({ host: r.host as string, score: Number(r.score ?? 0) }));
        usable.sort((a, b) => b.score - a.score);
        return usable[0] ?? null;
    } catch {
        return null;
    }
}

// Choose whether to stick to last target or switch to best target
function chooseStickyTarget(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    hackLevel: number,
    best: TargetEntry | null
): TargetEntry | null {
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
function isValid(ns: NS, host: string, hackLevel: number): boolean {
    return ns.serverExists(host)
        && ns.hasRootAccess(host)
        && ns.getServerMaxMoney(host) > 0
        && ns.getServerRequiredHackingLevel(host) <= hackLevel;
}

// ============== Singularity Helpers (controller-side, no singularity API) ==============

// --- New: smart faction chooser + cache upkeep ---

async function applyFactionCacheFromFiles(
    ns: NS,
    ctrl: ControllerState,
    dataPath: DataPaths
): Promise<void> {
    // Rep cache
    try {
        const repObj = await readJSON(ns, dataPath.factionRep) as { ok?: boolean; faction?: string; rep?: number } | null;
        if (repObj?.ok && typeof repObj?.faction === "string" && typeof repObj?.rep === "number") {
            ctrl.factionRepCache ??= {};
            ctrl.factionRepCache[repObj.faction] = { rep: repObj.rep, ts: Date.now() };
        }
    } catch {
        // ignore
    }

    // Aug list cache
    try {
        const augsObj = await readJSON(ns, dataPath.augsFaction) as { ok?: boolean; faction?: string; augs?: string[] } | null;
        if (augsObj?.ok && typeof augsObj?.faction === "string" && Array.isArray(augsObj?.augs)) {
            ctrl.factionAugsCache ??= {};
            ctrl.factionAugsCache[augsObj.faction] = { augs: augsObj.augs.slice(), ts: Date.now() };
        }
    } catch {
        // ignore
    }
}

function maybeStartFactionCacheUpdate(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    now: number,
    dataPath: DataPaths
): number {
    const fc = CFG.factionChooser ?? {};
    const factions = ns.getPlayer().factions ?? [];
    if (!factions.length) return 0;

    // Only poke caches occasionally, and only when we're not already doing other work.
    if (now - (ctrl.lastFactionCacheUpdateTs ?? 0) < (fc.cacheUpdateEveryMs ?? 10_000)) return 0;
    if (ctrl.syscallPid && ns.isRunning(ctrl.syscallPid)) return 0;

    // If we have a pending purchase/install, don't delay that with cache maintenance.
    if (ctrl.pendingPurchase) return 0;

    ctrl.factionRepCache ??= {};
    ctrl.factionAugsCache ??= {};
    ctrl.factionCacheIndex ??= 0;

    // Round-robin over factions
    for (let i = 0; i < factions.length; i++) {
        const f = factions[(ctrl.factionCacheIndex + i) % factions.length];

        const repTs = ctrl.factionRepCache[f]?.ts ?? 0;
        const augsTs = ctrl.factionAugsCache[f]?.ts ?? 0;

        const repStale = (now - repTs) > (fc.repCacheMs ?? 300_000);
        const augsStale = (now - augsTs) > (fc.augsCacheMs ?? 900_000);

        // Prefer rep refresh first (cheaper + used everywhere)
        if (repStale) {
            const key = `syscall:cache-rep:${f}`;
            const pid = trySyscall(ns, ctrl, key, "scripts/singularity/get-faction-rep.js", [f, dataPath.factionRep], 1000);
            if (pid !== 0) {
                ctrl.syscallKey = key;
                ctrl.lastFactionCacheUpdateTs = now;
                ctrl.factionCacheIndex = (ctrl.factionCacheIndex + i + 1) % factions.length;
                return pid;
            }
        }

        if (augsStale) {
            const key = `syscall:cache-augs:${f}`;
            const pid = trySyscall(ns, ctrl, key, "scripts/singularity/get-augs-from-faction.js", [f, dataPath.augsFaction], 1500);
            if (pid !== 0) {
                ctrl.syscallKey = key;
                ctrl.lastFactionCacheUpdateTs = now;
                ctrl.factionCacheIndex = (ctrl.factionCacheIndex + i + 1) % factions.length;
                return pid;
            }
        }
    }

    // Everything fresh enough
    ctrl.lastFactionCacheUpdateTs = now;
    return 0;
}

function pickFactionToWorkSmart(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    ownedSet: Set<string>
): string | null {
    const factions = ns.getPlayer().factions ?? [];
    if (!factions.length) return null;

    ctrl.factionRepCache ??= {};
    ctrl.factionAugsCache ??= {};

    const fc = CFG.factionChooser ?? {};
    const repGapPenalty = fc.repGapPenalty ?? 1.0;
    const buyNowBonus = fc.buyNowBonus ?? 1e9;
    const crossPenalty = fc.crossFactionPrereqPenalty ?? 0.25;

    const cash = ns.getPlayer().money;
    const spendCap = Math.max(0, cash * CFG.maxAugSpendFraction);

    let bestPick: { faction: string; score: number } | null = null;

    for (const f of factions) {
        const repNow = ctrl.factionRepCache[f]?.rep ?? 0;
        const augsEntry = ctrl.factionAugsCache[f];
        const augs = Array.isArray(augsEntry?.augs) ? augsEntry.augs : null;
        if (!augs || !augs.length) continue;

        let bestAug: { aug: string; score: number } | null = null;

        for (const aug of augs) {
            if (ownedSet.has(aug)) continue;

            const facts = ctrl.augFacts?.[aug];
            if (!facts) continue;
            if (typeof facts.price !== "number" || typeof facts.repReq !== "number") continue;
            if (!facts.stats || !Array.isArray(facts.prereqs)) continue;

            const repGap = Math.max(0, facts.repReq - repNow);
            const missing = firstMissingPrereq(facts.prereqs, ownedSet);

            // prereq penalty: missing prereq not sold by same faction is a big hassle
            let prereqMult = 1.0;
            if (missing) {
                const prereqSoldHere = augs.includes(missing);
                prereqMult = prereqSoldHere ? 0.8 : crossPenalty;
            }

            const roi = augRoiScore(facts.stats, facts.price);
            let score = (roi * prereqMult) / (1 + repGap * repGapPenalty);

            // "Buy now" dominates: if it's buyable now, that's the faction you should work with
            const buyableNow =
                !missing &&
                repGap === 0 &&
                facts.price <= spendCap &&
                (cash - facts.price) >= (CFG.minCashReserve ?? 0);

            if (buyableNow) score += buyNowBonus;

            if (!bestAug || score > bestAug.score) {
                bestAug = { aug, score };
            }
        }

        if (!bestAug) continue;

        if (!bestPick || bestAug.score > bestPick.score) {
            bestPick = { faction: f, score: bestAug.score };
        }
    }

    // Fallback to existing priority list until caches/facts exist
    if (!bestPick) {
        for (const f of (CFG.factionPriority ?? [])) if (factions.includes(f)) return f;
        return factions[0];
    }

    return bestPick.faction;
}

function firstMissingPrereq(prereqs: string[], ownedSet: Set<string>): string | null {
    if (!Array.isArray(prereqs)) return null;
    for (const p of prereqs) if (!ownedSet.has(p)) return p;
    return null;
}

// Read pending aug count
async function readPendingCount(
    ns: NS,
    path: string,
    fallback: number
): Promise<number> {
    try {
        const obj = await readJSON(ns, path) as { pendingCount?: number; pending?: unknown[] } | null;
        if (typeof obj?.pendingCount === "number") return obj.pendingCount;
        const pending = obj?.pending;
        if (Array.isArray(pending)) return pending.length;
        return fallback;
    } catch {
        return fallback;
    }
}

// Read invites list
async function readInvites(
    ns: NS,
    path: string,
    fallback: string[]
): Promise<string[]> {
    try {
        const obj = await readJSON(ns, path) as { invites?: string[] } | null;
        const invites = obj?.invites;
        if (Array.isArray(invites)) return invites.slice();
        return fallback;
    } catch {
        return fallback;
    }
}

// Clamp to number or fallback
function clampNumber(x: unknown, fallback = 0): number {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
}

// Keep only aug facts for a set of augs, up to a max count
function pruneAugFacts(
    ctrl: ControllerState,
    keepSet: Set<string>,
    maxKeep: number
): void {
    if (!ctrl.augFacts) ctrl.augFacts = {};
    const keys = Object.keys(ctrl.augFacts);
    if (keys.length <= maxKeep) return;

    for (const k of keys) {
        if (!keepSet.has(k)) delete ctrl.augFacts[k];
        if (Object.keys(ctrl.augFacts).length <= maxKeep) break;
    }
}

// Aug value function (hacking + charisma multipliers)
function mult(stats: AugStats | undefined, key: string): number {
    const v = stats?.[key];
    return (typeof v === "number" && Number.isFinite(v)) ? v : 1;
}

// Return value score for aug based on hacking + charisma multipliers
function augValueHackCha(stats: AugStats | undefined): number {
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
function augRoiScore(stats: AugStats | undefined, price: number): number {
    const v = augValueHackCha(stats);
    if (!Number.isFinite(price) || price <= 0) return 0;
    return v / price;
}
