import type { NS } from "@ns";
import { getBool, getNumber } from "/lib/settings.js";
import type { StockManagerConfig } from "/domain/stocks/types.js";

export function getStockManagerConfig(ns: NS): StockManagerConfig {
    return {
        rebalanceMs: getNumber(ns, "stocks.rebalanceMs"),
        cooldownMs: getNumber(ns, "stocks.cooldownMs"),
        maxActionsPerTick: getNumber(ns, "stocks.maxActionsPerTick"),

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

        minCashAbs: getNumber(ns, "stocks.cash.minCashAbs"),
        minCashFrac: getNumber(ns, "stocks.cash.minCashFrac"),

        maxDrawdownFrac: getNumber(ns, "stocks.risk.maxDrawdownFrac"),
        pauseAfterKillMs: getNumber(ns, "stocks.risk.pauseAfterKillMs"),

        trendLongOnly: getBool(ns, "stocks.trend.longOnly"),
        trendMaxSymbolFrac: getNumber(ns, "stocks.trend.maxSymbolFrac"),
        trendMaxTotalFrac: getNumber(ns, "stocks.trend.maxTotalFrac"),
        maxSpreadFrac: getNumber(ns, "stocks.trend.maxSpreadFrac"),
        minPrice: getNumber(ns, "stocks.trend.minPrice"),
    };
}

export type { StockManagerConfig } from "/domain/stocks/types.js";
