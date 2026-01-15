import { describe, expect, it } from "vitest";
import { computeTrendDesires } from "../src/app/stocks/logic.js";
import type {
    NormalizedConfig,
    SymbolSnapshot,
} from "../src/domain/stocks/types.js";

const baseCfg: NormalizedConfig = {
    rebalanceMs: 6000,
    cooldownMs: 20_000,
    maxActionsPerTick: 6,
    use4S: false,
    enterLong: 0.6,
    exitLong: 0.55,
    enterShort: 0.4,
    exitShort: 0.45,
    priceHistoryMax: 80,
    emaFast: 2,
    emaSlow: 4,
    trendEnter: 0.0001,
    trendExit: 0,
    maxSymbolFrac: 0.1,
    maxTotalFrac: 0.8,
    maxOpenSymbols: 2,
    minCashAbs: 40_000_000,
    minCashFrac: 0.1,
    maxDrawdownFrac: 0.15,
    pauseAfterKillMs: 5 * 60 * 1000,
    trendLongOnly: false,
    trendMaxSymbolFrac: 0.12,
    trendMaxTotalFrac: 0.25,
    maxSpreadFrac: 0.03,
    minPrice: 1,
};

const equity = 100_000;
const tape = [100, 101, 102, 103, 104, 105, 106, 107, 108];

function makeCfg(overrides: Partial<NormalizedConfig>): NormalizedConfig {
    return { ...baseCfg, ...overrides };
}

function makeHistory(prices: number[]) {
    return prices.map((p, idx) => ({ t: idx, p }));
}

function makeSnapshot(
    sym: string,
    bid: number,
    ask: number,
    prices: number[]
): SymbolSnapshot {
    return {
        sym,
        bid,
        ask,
        price: (bid + ask) / 2,
        forecast: null,
        vol: null,
        longShares: 0,
        longPx: 0,
        shortShares: 0,
        shortPx: 0,
        maxShares: 1_000_000,
        history: makeHistory(prices),
    };
}

const snapshots: SymbolSnapshot[] = [
    makeSnapshot("AAA", 100, 100.6, tape),
    makeSnapshot("BBB", 50, 50.3, tape.map((p) => p * 1.01)),
    makeSnapshot("CCC", 30, 30.2, tape.map((p) => p * 0.99)),
];

describe("trend desires", () => {
    it("drops candidates when spreads are above the cap", () => {
        const cfg = makeCfg({ maxSpreadFrac: 0.003 });
        const res = computeTrendDesires(snapshots, equity, cfg);

        expect(res.desires.size).toBe(0);
        expect(res.debug.skipSpread).toBe(res.debug.total);
    });

    it("produces capped desires when spreads are permissive", () => {
        const cfg = makeCfg({ maxSpreadFrac: 0.03 });
        const res = computeTrendDesires(snapshots, equity, cfg);

        expect(res.desires.size).toBeGreaterThan(0);
        expect(res.desires.size).toBeLessThanOrEqual(cfg.maxOpenSymbols);
        expect(
            res.desires.size * cfg.trendMaxSymbolFrac
        ).toBeLessThanOrEqual(cfg.trendMaxTotalFrac + 1e-6);
        for (const desire of res.desires.values()) {
            expect(desire.targetShares).toBeGreaterThan(0);
        }
    });
});
