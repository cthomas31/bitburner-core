import type { NS } from "@ns";
import { readJSON } from "/lib/ns/io.js";
import type { ControllerConfig, ControllerState, DataPaths } from "/domain/controller/types.js";
import { trySyscall } from "/domain/controller/syscalls.js";
import { augRoiScore } from "/domain/controller/augs.js";

export async function applyFactionCacheFromFiles(
    ns: NS,
    ctrl: ControllerState,
    dataPath: DataPaths
): Promise<void> {
    // Rep cache
    try {
        const repObj = (await readJSON(ns, dataPath.factionRep)) as {
            ok?: boolean;
            faction?: string;
            rep?: number;
        } | null;
        if (
            repObj?.ok &&
            typeof repObj?.faction === "string" &&
            typeof repObj?.rep === "number"
        ) {
            ctrl.factionRepCache ??= {};
            ctrl.factionRepCache[repObj.faction] = {
                rep: repObj.rep,
                ts: Date.now(),
            };
        }
    } catch {
        // ignore
    }

    // Aug list cache
    try {
        const augsObj = (await readJSON(ns, dataPath.augsFaction)) as {
            ok?: boolean;
            faction?: string;
            augs?: string[];
        } | null;
        if (
            augsObj?.ok &&
            typeof augsObj?.faction === "string" &&
            Array.isArray(augsObj?.augs)
        ) {
            ctrl.factionAugsCache ??= {};
            ctrl.factionAugsCache[augsObj.faction] = {
                augs: augsObj.augs.slice(),
                ts: Date.now(),
            };
        }
    } catch {
        // ignore
    }
}

export function maybeStartFactionCacheUpdate(
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
    if (
        now - (ctrl.lastFactionCacheUpdateTs ?? 0) <
        (fc.cacheUpdateEveryMs ?? 10_000)
    )
        return 0;
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

        const repStale = now - repTs > (fc.repCacheMs ?? 300_000);
        const augsStale = now - augsTs > (fc.augsCacheMs ?? 900_000);

        // Prefer rep refresh first (cheaper + used everywhere)
        if (repStale) {
            const key = `syscall:cache-rep:${f}`;
            const pid = trySyscall(
                ns,
                ctrl,
                key,
                "scripts/singularity/get-faction-rep.js",
                [dataPath.factionRep, f],
                1000
            );
            if (pid !== 0) {
                ctrl.syscallKey = key;
                ctrl.lastFactionCacheUpdateTs = now;
                ctrl.factionCacheIndex =
                    (ctrl.factionCacheIndex + i + 1) % factions.length;
                return pid;
            }
        }

        if (augsStale) {
            const key = `syscall:cache-augs:${f}`;
            const pid = trySyscall(
                ns,
                ctrl,
                key,
                "scripts/singularity/get-augs-from-faction.js",
                [f, dataPath.augsFaction],
                1500
            );
            if (pid !== 0) {
                ctrl.syscallKey = key;
                ctrl.lastFactionCacheUpdateTs = now;
                ctrl.factionCacheIndex =
                    (ctrl.factionCacheIndex + i + 1) % factions.length;
                return pid;
            }
        }
    }

    // Everything fresh enough
    ctrl.lastFactionCacheUpdateTs = now;
    return 0;
}

export function pickFactionToWorkSmart(
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
            if (
                typeof facts.price !== "number" ||
                typeof facts.repReq !== "number"
            )
                continue;
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
                cash - facts.price >= (CFG.minCashReserve ?? 0);

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
        for (const f of CFG.factionPriority ?? [])
            if (factions.includes(f)) return f;
        return factions[0];
    }

    return bestPick.faction;
}

export function firstMissingPrereq(
    prereqs: string[],
    ownedSet: Set<string>
): string | null {
    if (!Array.isArray(prereqs)) return null;
    for (const p of prereqs) if (!ownedSet.has(p)) return p;
    return null;
}

// Read invites list
export async function readInvites(
    ns: NS,
    path: string,
    fallback: string[]
): Promise<string[]> {
    try {
        const obj = (await readJSON(ns, path)) as { invites?: string[] } | null;
        const invites = obj?.invites;
        if (Array.isArray(invites)) return invites.slice();
        return fallback;
    } catch {
        return fallback;
    }
}
