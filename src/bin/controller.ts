import type { NS } from "@ns";
import { readJSON, writeJSON } from "/lib/ns/io.js";
import { makeSettingsWatcher, reloadSettings } from "/lib/settings.js";
import { checkFactionServers } from "/app/hacking/check-faction-servers.js";
import { getDarkwebPrograms } from "/app/hacking/darkweb-programs.js";
import {
    AugStats,
    ScoredAug,
    ControllerConfig,
    ControllerState,
    DataPaths,
} from "/domain/controller/types.js";
import { getControllerConfig } from "/domain/controller/config.js";
import { makeStockManager, StockManager } from "/app/stocks/manager.js";
import { getStockManagerConfig } from "/domain/stocks/config.js";
import { drawUI } from "/domain/controller/ui.js";
import {
    pickMoneyFirstMode,
    reconcileWorkload,
    ensureDesiredRunning,
    ensureOnce,
} from "/domain/controller/workload.js";
import { trySyscall } from "/domain/controller/syscalls.js";
import {
    pickBestTarget,
    chooseStickyTarget,
} from "/domain/controller/targeting.js";
import {
    applyFactionCacheFromFiles,
    maybeStartFactionCacheUpdate,
    pickFactionToWorkSmart,
    firstMissingPrereq,
    readInvites,
} from "/domain/controller/factions.js";
import {
    pruneAugFacts,
    augRoiScore,
    clampNumber,
} from "/domain/controller/augs.js";

// ============== Main Entry Point ==============

export async function main(ns: NS): Promise<void> {
    ns.disableLog("ALL");
    ns.ui.openTail();

    // Refresh settings cache on controller start
    reloadSettings(ns);

    const CFG: ControllerConfig = getControllerConfig(ns);

    const dataPath: DataPaths = {
        owned: `${CFG.data_dir}/owned-augs.json`,
        owned_purchased: `${CFG.data_dir}/owned-augs-purchased.json`,
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

    const stockMgr: StockManager = makeStockManager(
        getStockManagerConfig(ns)
    );
    await stockMgr.init(ns, ctrl);

    // Ensure results dir exists (write a noop file)
    ns.write(`${CFG.data_dir}/keep.json`, "ok", "w");

    const maybeReloadSettings = makeSettingsWatcher(ns, "/settings.json", 2000);
    
    for (;;) {
        // Refresh settings if changed
        maybeReloadSettings();
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
            const syscallBackoffActive = Object.entries(
                ctrl.ensureBackoff
            ).some(([k, t]) => k.startsWith("syscall:") && Date.now() < t);

            if (
                !syscallBackoffActive &&
                ns.fileExists(CFG.scanScore, "home") &&
                now - ctrl.lastScanTs > CFG.scanEveryMs &&
                !ns.isRunning(CFG.scanScore, "home")
            ) {
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

                    const repObj = (await readJSON(
                        ns,
                        dataPath.factionRep
                    )) as { faction?: string; rep?: number } | null;
                    if (repObj?.faction === ctrl.chosenFaction) {
                        ctrl.factionRep = clampNumber(
                            repObj.rep,
                            ctrl.factionRep ?? 0
                        );
                    }

                    const priceObj = (await readJSON(
                        ns,
                        dataPath.augPrice
                    )) as { ok?: boolean; aug?: string; price?: number } | null;
                    if (priceObj?.ok && priceObj?.aug) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[priceObj.aug] ??= {};
                        ctrl.augFacts[priceObj.aug].price = clampNumber(
                            priceObj.price,
                            undefined
                        );
                    }

                    const repReqObj = (await readJSON(ns, dataPath.augRep)) as {
                        ok?: boolean;
                        aug?: string;
                        repReq?: number;
                    } | null;
                    if (repReqObj?.ok && repReqObj?.aug) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[repReqObj.aug] ??= {};
                        ctrl.augFacts[repReqObj.aug].repReq = clampNumber(
                            repReqObj.repReq,
                            undefined
                        );
                    }

                    const statsObj = (await readJSON(
                        ns,
                        dataPath.augStats
                    )) as {
                        ok?: boolean;
                        aug?: string;
                        stats?: AugStats;
                    } | null;
                    if (statsObj?.ok && statsObj?.aug && statsObj?.stats) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[statsObj.aug] ??= {};
                        ctrl.augFacts[statsObj.aug].stats = statsObj.stats;
                    }

                    const reqsObj = (await readJSON(ns, dataPath.augReqs)) as {
                        ok?: boolean;
                        aug?: string;
                        prereqs?: string[];
                    } | null;
                    if (
                        reqsObj?.ok &&
                        reqsObj?.aug &&
                        Array.isArray(reqsObj?.prereqs)
                    ) {
                        ctrl.augFacts ??= {};
                        ctrl.augFacts[reqsObj.aug] ??= {};
                        ctrl.augFacts[reqsObj.aug].prereqs =
                            reqsObj.prereqs.slice();
                    }
                }

                // Background cache upkeep: periodically refresh 1 faction (rep or aug list)
                // so smart chooser has data. This is intentionally gentle.
                {
                    const pid = maybeStartFactionCacheUpdate(
                        ns,
                        CFG,
                        ctrl,
                        now,
                        dataPath
                    );
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
                        const pid = trySyscall(
                            ns,
                            ctrl,
                            key,
                            "scripts/singularity/purchase-tor.js",
                            [],
                            1000
                        );
                        if (pid !== 0) {
                            ctrl.syscallPid = pid;
                            ctrl.syscallKey = key;
                        }
                    } else {
                        await getDarkwebPrograms(ns);
                    }
                    ctrl.lastDarkwebCheckTs = now;
                    ctrl.statusMessages.push(
                        new Date(ctrl.lastDarkwebCheckTs).toLocaleString() +
                            ": Checked darkweb programs"
                    );
                    break tick;
                }

                // Faction servers syscall
                if (
                    now - ctrl.lastFactionServersCheckTs >
                    CFG.checkFactionServersEveryMs
                ) {
                    await checkFactionServers(ns);
                    ctrl.lastFactionServersCheckTs = now;
                    ctrl.statusMessages.push(
                        new Date(
                            ctrl.lastFactionServersCheckTs
                        ).toLocaleString() + ": Checked faction servers"
                    );
                    break tick;
                }

                // (A) Check invites periodically
                if (now - ctrl.lastJoinInvitesTs > CFG.joinInvitesEveryMs) {
                    const key = "syscall:inv";
                    const pid = trySyscall(
                        ns,
                        ctrl,
                        key,
                        "scripts/singularity/check-invites.js",
                        [dataPath.invites],
                        1000
                    );
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastJoinInvitesTs = now;
                        ctrl.statusMessages.push(
                            new Date(ctrl.lastJoinInvitesTs).toLocaleString() +
                                ": Checked faction invites"
                        );
                        break tick;
                    }
                }

                // (B) Join one invite if present
                ctrl.invites = await readInvites(
                    ns,
                    dataPath.invites,
                    ctrl.invites
                );
                if (ctrl.invites?.length) {
                    const nextFaction = ctrl.invites[0];
                    const key = "syscall:join-faction";
                    const pid = trySyscall(
                        ns,
                        ctrl,
                        key,
                        "scripts/singularity/join-faction.js",
                        [dataPath.joinOut, nextFaction],
                        1000
                    );
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.invites.shift();
                        writeJSON(ns, dataPath.invites, {
                            ts: Date.now(),
                            invites: ctrl.invites,
                        });
                        ctrl.statusMessages.push(
                            new Date().toLocaleString() +
                                `: Joined faction ${nextFaction}`
                        );
                        break tick;
                    }
                }

                // (C) Refresh owned augs periodically
                if (now - ctrl.lastOwnedAugsTs > CFG.ownedAugsEveryMs) {
                    const key = "syscall:owned-augs";
                    const pid = trySyscall(
                        ns,
                        ctrl,
                        key,
                        "scripts/singularity/get-owned-augs.js",
                        [dataPath.owned, false],
                        1000
                    );
                    if (pid !== 0) {
                        const key = "syscall:owned-augs-purchased"
                        const pid = trySyscall(
                            ns,
                            ctrl,
                            key,
                            "scripts/singularity/get-owned-augs.js",
                            [dataPath.owned_purchased, true],
                        )
                        if (pid !== 0) {
                            ctrl.syscallPid = pid;
                            ctrl.syscallKey = key;
                            ctrl.lastOwnedAugsTs = now;
                        }
                    }
                    break tick;
                }

                const ownedObj = (await readJSON(ns, dataPath.owned)) as {
                    owned?: string[];
                } | null;
                const rawOwned = ownedObj?.owned;
                const ownedList = Array.isArray(rawOwned) ? rawOwned : [];
                const ownedSet = new Set(ownedList);
                ctrl.ownedSet = ownedSet;

                const ownedPurchasedObj = (await readJSON(ns, dataPath.owned_purchased)) as {
                    owned?: string[];
                } | null;
                const rawOwnedPurchased = ownedPurchasedObj?.owned;
                const ownedPurchasedList = Array.isArray(rawOwnedPurchased) ? rawOwnedPurchased : [];
                const ownedPurchasedSet = new Set(ownedPurchasedList);
                const pendingSet = [...ownedPurchasedSet].filter(a => !ownedSet.has(a));
                ctrl.pendingAugsCount = pendingSet.length;

                // Decide faction AFTER we know what we own and AFTER caches can be updated.
                // Falls back to priority list until caches fill in.
                ctrl.chosenFaction = pickFactionToWorkSmart(
                    ns,
                    CFG,
                    ctrl,
                    ownedSet
                );

                // (D) Refresh faction rep periodically
                if (
                    ctrl.chosenFaction &&
                    now - ctrl.lastFactionRepTs > CFG.factionRepEveryMs
                ) {
                    const key = "syscall:get-faction-rep";
                    const pid = trySyscall(
                        ns,
                        ctrl,
                        key,
                        "scripts/singularity/get-faction-rep.js",
                        [dataPath.factionRep, ctrl.chosenFaction],
                        1000
                    );
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastFactionRepTs = now;
                        break tick;
                    }
                }

                // (E) Refresh augs-from-faction occasionally
                if (
                    ctrl.chosenFaction &&
                    now - ctrl.lastAugsFromFactionTs >
                        CFG.augsFromFactionEveryMs
                ) {
                    const key = "syscall:augs-from-faction";
                    const pid = trySyscall(
                        ns,
                        ctrl,
                        key,
                        "scripts/singularity/get-augs-from-faction.js",
                        [dataPath.augsFaction, ctrl.chosenFaction],
                        1000
                    );
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastAugsFromFactionTs = now;
                        break tick;
                    }
                }

                // Update cached augs list + candidates
                const augsObj = (await readJSON(ns, dataPath.augsFaction)) as {
                    ok?: boolean;
                    faction?: string;
                    augs?: string[];
                } | null;
                if (
                    augsObj?.ok &&
                    augsObj?.faction === ctrl.chosenFaction &&
                    Array.isArray(augsObj?.augs)
                ) {
                    ctrl.augsFromFaction = augsObj.augs.slice();
                    // all augs offered by chosen faction minus owned
                    ctrl.augCandidates = ctrl.augsFromFaction.filter(
                        (a) => !ownedSet.has(a)
                    );

                    // keep cache bounded
                    pruneAugFacts(
                        ctrl,
                        new Set(ctrl.augCandidates),
                        CFG.maxAugFactsCache
                    );
                }

                // (F) Attempt pending purchase
                if (
                    ctrl.pendingPurchase &&
                    now - ctrl.lastAugBuyTs > CFG.augBuyCooldownMs
                ) {
                    const { faction, aug } = ctrl.pendingPurchase;
                    const key = "syscall:purchase-aug";
                    const pid = trySyscall(
                        ns,
                        ctrl,
                        key,
                        "scripts/singularity/purchase-aug.js",
                        [faction, aug, dataPath.buy],
                        1500
                    );
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
                        const aug = ctrl.augCandidates.find((a) => {
                            const f = ctrl.augFacts?.[a];
                            // need price or rep
                            return (
                                !f ||
                                !Number.isFinite(f.price) ||
                                !Number.isFinite(f.repReq)
                            );
                        });

                        if (aug) {
                            ctrl.augFacts ??= {};
                            ctrl.augFacts[aug] ??= {};
                            const f = ctrl.augFacts[aug];

                            let pid = 0;
                            let key: string | null = null;
                            if (!Number.isFinite(f.price)) {
                                key = "syscall:get-aug-price";
                                pid = trySyscall(
                                    ns,
                                    ctrl,
                                    key,
                                    "scripts/singularity/get-aug-price.js",
                                    [dataPath.augPrice, aug],
                                    1000
                                );
                            } else if (!Number.isFinite(f.repReq)) {
                                key = "syscall:get-aug-rep";
                                pid = trySyscall(
                                    ns,
                                    ctrl,
                                    key,
                                    "scripts/singularity/get-aug-rep.js",
                                    [dataPath.augRep, aug],
                                    1000
                                );
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
                        const aug = ctrl.augCandidates.find((a) => {
                            const f = ctrl.augFacts?.[a];
                            if (!f) return false;
                            if (
                                !Number.isFinite(f.price) ||
                                !Number.isFinite(f.repReq)
                            )
                                return false;
                            if (f.stats) return false;
                            // only bother if close to reach
                            const rep = ctrl.factionRep ?? 0;
                            return (f.repReq ?? 0) <= rep + CFG.repReachBuffer;
                        });

                        if (aug) {
                            const key = "syscall:get-aug-stats";
                            const pid = trySyscall(
                                ns,
                                ctrl,
                                key,
                                "scripts/singularity/get-aug-stats.js",
                                [dataPath.augStats, aug],
                                1500
                            );
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
                        const aug = ctrl.augCandidates.find((a) => {
                            const f = ctrl.augFacts?.[a];
                            if (!f) return false;
                            if (
                                !Number.isFinite(f.price) ||
                                !Number.isFinite(f.repReq)
                            )
                                return false;
                            if (f.prereqs) return false;
                            // if not close to reach, skip
                            const rep = ctrl.factionRep ?? 0;
                            return (f.repReq ?? 0) <= rep + CFG.repReachBuffer;
                        });

                        if (aug) {
                            const key = "syscall:get-aug-prereqs";
                            const pid = trySyscall(
                                ns,
                                ctrl,
                                key,
                                "scripts/singularity/get-aug-prereqs.js",
                                [dataPath.augReqs, aug],
                                1500
                            );
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
                    const spendCap = Math.max(
                        0,
                        cash * CFG.maxAugSpendFraction
                    );
                    const reserve = CFG.minCashReserve;
                    const repNow = ctrl.factionRep ?? 0;

                    // Build scored list
                    const scored: ScoredAug[] = ctrl.augCandidates
                        .map((aug) => {
                            const f = ctrl.augFacts?.[aug];
                            if (!f) return null;
                            if (
                                !Number.isFinite(f.price) ||
                                !Number.isFinite(f.repReq) ||
                                !f.stats ||
                                !Array.isArray(f.prereqs)
                            )
                                return null;
                            const missing = firstMissingPrereq(
                                f.prereqs,
                                ownedSet
                            );
                            const roi = augRoiScore(f.stats, f.price ?? 0);
                            return {
                                aug,
                                price: f.price ?? 0,
                                repReq: f.repReq ?? 0,
                                roi,
                                missing,
                            };
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
                        if (
                            pf &&
                            Number.isFinite(pf.price) &&
                            Number.isFinite(pf.repReq) &&
                            pf.stats &&
                            Array.isArray(pf.prereqs)
                        ) {
                            desired = {
                                aug: prereq,
                                price: pf.price ?? 0,
                                repReq: pf.repReq ?? 0,
                                roi: augRoiScore(pf.stats, pf.price ?? 0),
                                missing: firstMissingPrereq(
                                    pf.prereqs,
                                    ownedSet
                                ),
                            };
                        } else {
                            // ensure prereq is in our augCandidates if the faction offers it
                            // (if not, we can't solve it here; you'll need a multi-faction planner later)
                        }
                    }

                    if (
                        desired &&
                        desired.repReq <= repNow &&
                        desired.price <= spendCap &&
                        cash - desired.price >= reserve &&
                        !desired.missing
                    ) {
                        if (ctrl.chosenFaction) {
                            ctrl.pendingPurchase = {
                                faction: ctrl.chosenFaction,
                                aug: desired.aug,
                            };
                        }
                    }
                }

                // (H) Install if enough pending augs and cooldown elapsed
                const canInstall =
                    ctrl.pendingAugsCount >= CFG.minPendingAugs &&
                    now - ctrl.lastInstallTs > CFG.installCooldownMs;

                if (canInstall) {
                    const key = "syscall:install-augs";
                    const pid = trySyscall(
                        ns,
                        ctrl,
                        key,
                        "scripts/singularity/install.js",
                        [dataPath.install, "bootstrap.js"],
                        2000
                    );
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        ctrl.syscallKey = key;
                        ctrl.lastInstallTs = now;
                        break tick;
                    }
                }

                // (I) keep working for faction
                if (
                    ctrl.chosenFaction &&
                    now - ctrl.lastWorkFactionTs > CFG.workFactionEveryMs
                ) {
                    const key = "syscall:work-faction";
                    const pid = trySyscall(
                        ns,
                        ctrl,
                        key,
                        "scripts/singularity/work-faction.js",
                        [
                            dataPath.work,
                            ctrl.chosenFaction,
                            CFG.factionWorkType,
                            false
                        ],
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
        const stockLines = stockMgr.status(ctrl);
        await drawUI(
            ns,
            CFG,
            ctrl,
            best,
            mode,
            target,
            hack,
            formulas,
            stockLines
        );
        await ns.sleep(CFG.tickMs);
    }
}
