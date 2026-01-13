// ============== Type Definitions for Stocks ==============

export interface StockManagerConfig {
    // runtime
    rebalanceMs?: number;
    cooldownMs?: number;
    maxActionsPerTick?: number;

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
}

export interface NormalizedConfig {
    rebalanceMs: number;
    cooldownMs: number;
    maxActionsPerTick: number;
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
