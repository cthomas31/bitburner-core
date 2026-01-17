import { describe, expect, it } from "vitest";
import {
    isWithinTolerance,
    orderThresholdReasons,
    tradeIntervalBlocked,
} from "../src/app/stocks/logic.js";
import type { NormalizedConfig } from "../src/domain/stocks/types.js";

const cfg: NormalizedConfig = {
    rebalanceMs: 0,
    cooldownMs: 0,
    cooldownTicks: 0,
    decisionIntervalTicks: 1,
    maxActionsPerTick: 0,
    minHoldTicks: 10,
    minHoldAfterEntryTicks: 10,
    minTradeIntervalTicks: 10,
    logFile: "/dev/null",
    logVerbosity: "quiet",
    use4S: false,
    enterLong: 0,
    exitLong: 0,
    enterShort: 0,
    exitShort: 0,
    priceHistoryMax: 0,
    emaFast: 0,
    emaSlow: 0,
    trendEnter: 0,
    trendExit: 0,
    maxSymbolFrac: 0,
    maxTotalFrac: 0,
    maxOpenSymbols: 0,
    minDeltaShares: 10,
    minOrderNotional: 5_000_000,
    positionToleranceFrac: 0.05,
    minCashAbs: 0,
    minCashFrac: 0,
    maxDrawdownFrac: 0,
    pauseAfterKillMs: 0,
    externalSpendResetFrac: 1,
    resetEquityPeakOnBoot: false,
    trendLongOnly: false,
    trendMaxSymbolFrac: 0,
    trendMaxTotalFrac: 0,
    maxSpreadFrac: 0.1,
    minPrice: 0,
    minSignalFrac: 0.004,
    spreadEdgeBufferFrac: 0.001,
    frictionMinEdgeFrac: 0,
    frictionIncludeCommission: false,
};

describe("order gating", () => {
    it("flags orders below minimum share threshold", () => {
        const reasons = orderThresholdReasons(
            cfg.minDeltaShares - 1,
            cfg.minOrderNotional + 1,
            cfg
        );
        expect(reasons).toContain("min_shares");
    });

    it("flags orders below minimum notional threshold", () => {
        const reasons = orderThresholdReasons(
            cfg.minDeltaShares + 1,
            cfg.minOrderNotional - 1,
            cfg
        );
        expect(reasons).toContain("min_notional");
    });

    it("trade interval prevents immediate side flip", () => {
        const last = { tick: 10, side: "BUY" as const };
        const res = tradeIntervalBlocked(
            last,
            12,
            cfg.minTradeIntervalTicks
        );
        expect(res.blocked).toBe(true);
        expect(res.ticksSince).toBe(2);
    });

    it("tolerance band skips tiny rebalances", () => {
        const currentValue = 1_000_000;
        const targetValue = 1_040_000; // 4% off
        expect(
            isWithinTolerance(
                currentValue,
                targetValue,
                cfg.positionToleranceFrac
            )
        ).toBe(true);
        expect(
            isWithinTolerance(
                currentValue,
                targetValue * 1.2,
                cfg.positionToleranceFrac
            )
        ).toBe(false);
    });
});
