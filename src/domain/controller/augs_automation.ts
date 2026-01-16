import type { NS } from "@ns";
import { readJSON } from "/lib/ns/io.js";
import {
    augRoiScore,
    clampNumber,
    pruneAugFacts,
} from "/domain/controller/augs.js";
import { firstMissingPrereq } from "/domain/controller/factions.js";
import { trySyscall } from "/domain/controller/syscalls.js";
import type {
    AugStats,
    ControllerConfig,
    ControllerState,
    DataPaths,
    ScoredAug,
} from "/domain/controller/types.js";

export async function applyAugFactsFromFiles(
    ns: NS,
    ctrl: ControllerState,
    dataPath: DataPaths
): Promise<void> {
    const priceObj = (await readJSON(ns, dataPath.augPrice)) as {
        ok?: boolean;
        aug?: string;
        price?: number;
    } | null;
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

    const statsObj = (await readJSON(ns, dataPath.augStats)) as {
        ok?: boolean;
        aug?: string;
        stats?: unknown;
    } | null;
    if (statsObj?.ok && statsObj?.aug && statsObj?.stats) {
        ctrl.augFacts ??= {};
        ctrl.augFacts[statsObj.aug] ??= {};
        ctrl.augFacts[statsObj.aug].stats = statsObj.stats as AugStats;
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
        ctrl.augFacts[reqsObj.aug].prereqs = reqsObj.prereqs.slice();
    }
}

export async function applyOwnedAugsFromFiles(
    ns: NS,
    ctrl: ControllerState,
    dataPath: DataPaths
): Promise<void> {
    const ownedObj = (await readJSON(ns, dataPath.owned)) as {
        owned?: string[];
    } | null;
    const rawOwned = ownedObj?.owned;
    const ownedList = Array.isArray(rawOwned) ? rawOwned : [];
    const ownedSet = new Set(ownedList);
    ctrl.ownedSet = ownedSet;

    const ownedPurchasedObj = (await readJSON(
        ns,
        dataPath.owned_purchased
    )) as {
        owned?: string[];
    } | null;
    const rawOwnedPurchased = ownedPurchasedObj?.owned;
    const ownedPurchasedList = Array.isArray(rawOwnedPurchased)
        ? rawOwnedPurchased
        : [];
    const ownedPurchasedSet = new Set(ownedPurchasedList);
    const pendingSet = [...ownedPurchasedSet].filter((a) => !ownedSet.has(a));
    ctrl.pendingAugsCount = pendingSet.length;
}

export async function tickAugs(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    now: number,
    dataPath: DataPaths,
    opts?: { factionsEnabled?: boolean }
): Promise<"started_syscall" | "noop"> {
    const factionsEnabled = opts?.factionsEnabled ?? true;

    // (C) Refresh owned augs periodically
    if (now - ctrl.lastOwnedAugsTs > CFG.ownedAugsEveryMs) {
        let trackedPid = 0;
        let trackedKey: string | null = null;

        const ownedPid = trySyscall(
            ns,
            ctrl,
            "syscall:owned-augs",
            "scripts/singularity/get-owned-augs.js",
            [dataPath.owned, false],
            1000
        );
        if (ownedPid !== 0) {
            trackedPid = ownedPid;
            trackedKey = "syscall:owned-augs";
        }

        const purchasedPid = trySyscall(
            ns,
            ctrl,
            "syscall:owned-augs-purchased",
            "scripts/singularity/get-owned-augs.js",
            [dataPath.owned_purchased, true]
        );
        if (purchasedPid !== 0) {
            trackedPid = purchasedPid;
            trackedKey = "syscall:owned-augs-purchased";
        }

        if (trackedPid !== 0) {
            ctrl.syscallPid = trackedPid;
            ctrl.syscallKey = trackedKey;
            ctrl.lastOwnedAugsTs = now;
            return "started_syscall";
        }
    }

    const ownedSet = ctrl.ownedSet ?? new Set<string>();
    ctrl.ownedSet = ownedSet;
    ctrl.pendingAugsCount ??= 0;

    const factionPipelineActive = factionsEnabled && !!ctrl.chosenFaction;

    // (E) Refresh augs-from-faction occasionally
    if (
        factionPipelineActive &&
        now - ctrl.lastAugsFromFactionTs > CFG.augsFromFactionEveryMs
    ) {
        const key = "syscall:augs-from-faction";
        const pid = trySyscall(
            ns,
            ctrl,
            key,
            "scripts/singularity/get-augs-from-faction.js",
            [dataPath.augsFaction, ctrl.chosenFaction as string],
            1000
        );
        if (pid !== 0) {
            ctrl.syscallPid = pid;
            ctrl.syscallKey = key;
            ctrl.lastAugsFromFactionTs = now;
            return "started_syscall";
        }
    }

    if (factionPipelineActive) {
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
            pruneAugFacts(ctrl, new Set(ctrl.augCandidates), CFG.maxAugFactsCache);
        }
    } else {
        ctrl.augsFromFaction = [];
        ctrl.augCandidates = [];
        if (!factionsEnabled) {
            ctrl.pendingPurchase = null;
        }
    }

    // (F) Attempt pending purchase
    if (
        factionPipelineActive &&
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
            [dataPath.buy, faction, aug],
            1500
        );
        if (pid !== 0) {
            ctrl.syscallPid = pid;
            ctrl.syscallKey = key;
            ctrl.lastAugBuyTs = now;
            ctrl.pendingPurchase = null;
            return "started_syscall";
        }
    }

    // (G) Probe missing facts and/or decide what to buy
    if (factionPipelineActive && ctrl.augCandidates?.length) {
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
                    return "started_syscall";
                }
            }
        }

        // 2) stats probe (80GB), gated by rep reach window
        if (now - ctrl.lastAugStatsTs > CFG.augStatsEveryMs) {
            const aug = ctrl.augCandidates.find((a) => {
                const f = ctrl.augFacts?.[a];
                if (!f) return false;
                if (!Number.isFinite(f.price) || !Number.isFinite(f.repReq))
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
                    return "started_syscall";
                }
            }
        }

        // 3) prereq probe (useful, but can be expensive), also gated
        if (now - ctrl.lastAugPrereqTs > CFG.augPrereqEveryMs) {
            const aug = ctrl.augCandidates.find((a) => {
                const f = ctrl.augFacts?.[a];
                if (!f) return false;
                if (!Number.isFinite(f.price) || !Number.isFinite(f.repReq))
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
                    return "started_syscall";
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
                const missing = firstMissingPrereq(f.prereqs, ownedSet);
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
                    missing: firstMissingPrereq(pf.prereqs, ownedSet),
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
            return "started_syscall";
        }
    }

    return "noop";
}
