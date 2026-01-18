import type { NS } from "@ns";
import { getBool, getNumber, getString } from "/lib/settings.js";
import type { StockManagerConfig } from "/domain/stocks/types.js";

export function getStockManagerConfig(ns: NS): StockManagerConfig {
    return {
        pauseEntries: getBool(ns, "stocks.pauseEntries"),
        rebalanceMs: getNumber(ns, "stocks.rebalanceMs"),
        cooldownMs: getNumber(ns, "stocks.cooldownMs"),
        cooldownTicks: getNumber(ns, "stocks.cooldownTicks"),
        decisionIntervalTicks: getNumber(ns, "stocks.decisionIntervalTicks"),
        maxActionsPerTick: getNumber(ns, "stocks.maxActionsPerTick"),
        minHoldTicks: getNumber(ns, "stocks.minHoldTicks"),
        logFile: getString(ns, "stocks.logFile"),

        use4S: getBool(ns, "stocks.use4S"),
        enterLong: getNumber(ns, "stocks.forecast.enterLong"),
        exitLong: getNumber(ns, "stocks.forecast.exitLong"),
        enterShort: getNumber(ns, "stocks.forecast.enterShort"),
        exitShort: getNumber(ns, "stocks.forecast.exitShort"),

        priceHistoryMax: getNumber(ns, "stocks.history.priceHistoryMax"),
        emaFast: getNumber(ns, "stocks.history.emaFast"),
        emaSlow: getNumber(ns, "stocks.history.emaSlow"),
        trendEnter: getNumber(ns, "stocks.history.trendEnter"),
        trendExit: getNumber(ns, "stocks.history.trendExit"),

        maxSymbolFrac: getNumber(ns, "stocks.sizing.maxSymbolFrac"),
        maxTotalFrac: getNumber(ns, "stocks.sizing.maxTotalFrac"),
        maxOpenSymbols: getNumber(ns, "stocks.sizing.maxOpenSymbols"),
        minDeltaShares: getNumber(ns, "stocks.sizing.minDeltaShares"),
        minOrderNotional: getNumber(ns, "stocks.sizing.minOrderNotional"),
        positionToleranceFrac: getNumber(
            ns,
            "stocks.sizing.positionToleranceFrac"
        ),

        minCashAbs: getNumber(ns, "stocks.cash.minCashAbs"),
        minCashFrac: getNumber(ns, "stocks.cash.minCashFrac"),

        maxDrawdownFrac: getNumber(ns, "stocks.risk.maxDrawdownFrac"),
        pauseAfterKillMs: getNumber(ns, "stocks.risk.pauseAfterKillMs"),
        externalSpendResetFrac: getNumber(
            ns,
            "stocks.externalSpendResetFrac"
        ),
        resetEquityPeakOnBoot: getBool(ns, "stocks.resetEquityPeakOnBoot"),

        trendLongOnly: getBool(ns, "stocks.trend.longOnly"),
        trendMaxSymbolFrac: getNumber(ns, "stocks.trend.maxSymbolFrac"),
        trendMaxTotalFrac: getNumber(ns, "stocks.trend.maxTotalFrac"),
        maxSpreadFrac: getNumber(ns, "stocks.trend.maxSpreadFrac"),
        minPrice: getNumber(ns, "stocks.trend.minPrice"),
        minSignalFrac: getNumber(ns, "stocks.trend.minSignalFrac"),
        spreadEdgeBufferFrac: getNumber(
            ns,
            "stocks.trend.spreadEdgeBufferFrac"
        ),

        frictionMinEdgeFrac: getNumber(ns, "stocks.friction.minEdgeFrac"),
        frictionIncludeCommission: getBool(
            ns,
            "stocks.friction.includeCommission"
        ),
    };
}

export type { StockManagerConfig } from "/domain/stocks/types.js";
