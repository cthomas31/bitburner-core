// ============== Type Definitions for Controller ==============

import { StockState } from "/domain/stocks/types.js";

export interface FactionChooserConfig {
    repCacheMs: number;
    augsCacheMs: number;
    repGapPenalty: number;
    buyNowBonus: number;
    crossFactionPrereqPenalty: number;
    cacheUpdateEveryMs?: number;
}

export interface ControllerConfig {
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
    enableDarkwebChecks: boolean;
    enableCheckFactionServers: boolean;
    enableAugs: boolean;
    enableFactions: boolean;

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

export interface DataPaths {
    owned: string;
    owned_purchased: string;
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

export interface AugFacts {
    price?: number;
    repReq?: number;
    stats?: AugStats;
    prereqs?: string[];
}

export interface AugStats {
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

export interface FactionCacheEntry {
    rep: number;
    ts: number;
}

export interface FactionAugsCacheEntry {
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

export interface TargetEntry {
    host: string;
    score: number;
}

export interface ScoredAug {
    aug: string;
    price: number;
    repReq: number;
    roi: number;
    missing: string | null;
}
