// ============== Type Definitions for Stocks ==============

import { StockLogger } from "/domain/stocks/logger.js";

export interface StockManagerConfig {
    // runtime
    rebalanceMs?: number;
    cooldownMs?: number;
    maxActionsPerTick?: number;
    logFile?: string;

    // If true, auto-upgrade to forecast mode when 4S is available
    use4S?: boolean;

    // 4S forecast entries/exits (hysteresis)
    enterLong?: number;
    exitLong?: number;
    enterShort?: number;
    exitShort?: number;

    // trend mode parameters
    priceHistoryMax?: number;
    emaFast?: number;
    emaSlow?: number;
    trendEnter?: number;
    trendExit?: number;

    // sizing
    maxSymbolFrac?: number;
    maxTotalFrac?: number;
    maxOpenSymbols?: number;

    // cash buffer
    minCashAbs?: number;
    minCashFrac?: number;

    // risk management
    maxDrawdownFrac?: number;
    pauseAfterKillMs?: number;

    // trend mode sizing
    trendLongOnly?: boolean;
    trendMaxSymbolFrac?: number;
    trendMaxTotalFrac?: number;

    // other filters
    maxSpreadFrac?: number;
    minPrice?: number;
}

export interface NormalizedConfig {
    rebalanceMs: number;
    cooldownMs: number;
    maxActionsPerTick: number;
    logFile: string;
    use4S: boolean;
    enterLong: number;
    exitLong: number;
    enterShort: number;
    exitShort: number;
    priceHistoryMax: number;
    emaFast: number;
    emaSlow: number;
    trendEnter: number;
    trendExit: number;
    maxSymbolFrac: number;
    maxTotalFrac: number;
    maxOpenSymbols: number;
    minCashAbs: number;
    minCashFrac: number;
    maxDrawdownFrac: number;
    pauseAfterKillMs: number;
    trendLongOnly: boolean;
    trendMaxSymbolFrac: number;
    trendMaxTotalFrac: number;
    maxSpreadFrac: number;
    minPrice: number;
}

export interface PriceEntry {
    t: number;
    p: number;
}

export interface StockState {
    enabled: boolean;
    reason?: string;
    lastRebalance: number;
    cooldownUntil: Record<string, number>;
    prices: Record<string, PriceEntry[]>;
    entry: Record<string, number>;
    lastStatus: string;
    lastMode: string;
    equityPeak: number;
    pausedUntil: number;
    tick: number;
    runId: string;
    logger: StockLogger;
}

export interface SymbolSnapshot {
    sym: string;
    bid: number;
    ask: number;
    price: number;
    forecast: number | null;
    vol: number | null;
    longShares: number;
    longPx: number;
    shortShares: number;
    shortPx: number;
    maxShares: number;
    history: PriceEntry[];
}

export interface Desire {
    dir: "LONG" | "SHORT";
    targetShares: number;
    score: number;
}

export interface ScoredCandidate {
    sym: string;
    dir: "LONG" | "SHORT";
    score: number;
    targetShares: number;
}

export type TrendDebug = {
    total: number;
    passSpread: number;
    passMinPrice: number;
    passHist: number;
    passSlow: number;
    passDir: number;
    passLongOnly: number;
    passTargetShares: number;

    skipSpread: number;
    skipMinPrice: number;
    skipHist: number;
    skipSlow: number;
    skipNoDir: number;
    skipLongOnly: number;
    skipTargetShares: number;

    candidates: number; // pushed into scored

    minSpreadFrac: number;
    maxSpreadFrac: number;
    minSpreadSym: string;
    maxSpreadSym: string;

};
