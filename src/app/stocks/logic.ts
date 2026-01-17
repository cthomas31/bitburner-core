/*
* Stock trading logic
*/
import {
    Desire,
    NormalizedConfig,
    ScoredCandidate,
    SymbolSnapshot,
    TrendDebug,
    OrderSide,
    TradeNote,
} from "/domain/stocks/types.js";

/** 
 * Compute trend-based trading desires for a set of stock symbols.
 * 
 * @param snapshot - Current market snapshot for each symbol
 * @param equity - Total equity available for trading
 * @param cfg - Normalized configuration parameters
 * @returns A map of trading desires and debug information
 */
export function computeTrendDesires(
    snapshot: SymbolSnapshot[],
    equity: number,
    cfg: NormalizedConfig
): { desires: Map<string, Desire>; debug: TrendDebug } {
    const scored: ScoredCandidate[] = [];

    const debug: TrendDebug = {
        total: 0,
        passSpread: 0,
        passMinPrice: 0,
        passHist: 0,
        passSlow: 0,
        passDir: 0,
        passLongOnly: 0,
        passTargetShares: 0,

        skipSpread: 0,
        skipMinPrice: 0,
        skipHist: 0,
        skipSlow: 0,
        skipNoDir: 0,
        skipLongOnly: 0,
        skipTargetShares: 0,

        candidates: 0,

        minSpreadFrac: Number.POSITIVE_INFINITY,
        maxSpreadFrac: 0,
        minSpreadSym: "",
        maxSpreadSym: "",
    };

    for (const s of snapshot) {
        debug.total++;

        const spreadFrac = s.ask > 0 ? (s.ask - s.bid) / s.ask : 1;
        if (spreadFrac < debug.minSpreadFrac) {
            debug.minSpreadFrac = spreadFrac;
            debug.minSpreadSym = s.sym;
        }
        if (spreadFrac > debug.maxSpreadFrac) {
            debug.maxSpreadFrac = spreadFrac;
            debug.maxSpreadSym = s.sym;
        }

        if (spreadFrac > cfg.maxSpreadFrac) {
            debug.skipSpread++;
            continue;
        }
        debug.passSpread++;

        if (s.ask < cfg.minPrice) {
            debug.skipMinPrice++;
            continue;
        }
        debug.passMinPrice++;

        const hist = s.history ?? [];
        if (!hist || hist.length < Math.max(cfg.emaFast, cfg.emaSlow) + 2) {
            debug.skipHist++;
            continue;
        }
        debug.passHist++;

        const prices = hist.map((e) => e.p);
        const fast = ema(prices, cfg.emaFast);
        const slow = ema(prices, cfg.emaSlow);
        if (slow <= 0) {
            debug.skipSlow++;
            continue;
        }
        debug.passSlow++;

        const delta = (fast - slow) / slow;
        const spreadReason = spreadSignalReason(
            spreadFrac,
            Math.abs(delta),
            cfg
        );
        if (spreadReason) {
            debug.skipSignal = (debug.skipSignal ?? 0) + 1;
            continue;
        }
        debug.passSignal = (debug.passSignal ?? 0) + 1;

        const holdingLong = s.longShares > 0;
        const holdingShort = s.shortShares > 0;

        let dir: "LONG" | "SHORT" | null = null;

        if (holdingLong) {
            dir = delta > cfg.trendExit ? "LONG" : null;
        } else if (holdingShort) {
            dir = delta < -cfg.trendExit ? "SHORT" : null;
        } else {
            if (delta >= cfg.trendEnter) dir = "LONG";
            else if (delta <= -cfg.trendEnter) dir = "SHORT";
        }

        if (!dir) {
            debug.skipNoDir++;
            continue;
        }
        debug.passDir++;

        if (cfg.trendLongOnly && dir === "SHORT") {
            debug.skipLongOnly++;
            continue;
        }
        debug.passLongOnly++;

        const confidence = clamp(Math.abs(delta) / (cfg.trendEnter * 2), 0, 1);
        const targetFrac = cfg.trendMaxSymbolFrac * confidence;
        const targetValue = equity * targetFrac;
        const price = dir === "LONG" ? s.ask : s.bid;
        const targetShares = price > 0 ? Math.floor(targetValue / price) : 0;

        if (targetShares <= 0) {
            debug.skipTargetShares++;
            continue;
        }
        debug.passTargetShares++;

        scored.push({
            sym: s.sym,
            dir,
            score: confidence,
            targetShares,
            signalFrac: Math.abs(delta),
        });
        debug.candidates++;
    }

    scored.sort((a, b) => b.score - a.score);

    return {
        desires: capDesires(
            scored,
            cfg,
            cfg.trendMaxSymbolFrac,
            cfg.trendMaxTotalFrac
        ),
        debug,
    };
}

/**
 * Cap the trading desires based on per-symbol and total allocation limits.
 * @param scored - List of scored trading candidates
 * @param cfg - Normalized configuration parameters
 * @param perSymbolFrac - Maximum fraction of equity to allocate per symbol
 * @param totalCap - Maximum total fraction of equity to allocate
 * @returns A map of trading desires
 */
export function capDesires(
    scored: ScoredCandidate[],
    cfg: NormalizedConfig,
    perSymbolFrac: number,
    totalCap: number
): Map<string, Desire> {
    const desires = new Map<string, Desire>();

    let open = 0;
    let usedFrac = 0;

    for (const c of scored) {
        if (open >= cfg.maxOpenSymbols) break;

        const frac = perSymbolFrac;
        if (c.targetShares <= 0) continue;
        if (usedFrac + frac > totalCap) continue;

        desires.set(c.sym, {
            dir: c.dir,
            targetShares: c.targetShares,
            score: c.score,
            signalFrac: c.signalFrac,
        });

        open++;
        usedFrac += frac;
    }

    return desires;
}

/**
 * Compute the drawdown fraction given the peak and current equity.
 * @param equityPeak - The peak equity value
 * @param equityNow - The current equity value
 * @returns The drawdown fraction (0 to 1)
 */
export function drawdownFrac(equityPeak: number, equityNow: number): number {
    if (equityPeak <= 0) return 0;
    return Math.max(0, 1 - equityNow / equityPeak);
}

/**
 * Determine whether trading should be halted based on drawdown.
 * @param equityPeak - The peak equity value
 * @param equityNow - The current equity value
 * @param maxDrawdownFrac - The maximum allowed drawdown fraction
 * @returns True if trading should be halted, false otherwise
 */
export function shouldKillOnDrawdown(
    equityPeak: number,
    equityNow: number,
    maxDrawdownFrac: number
): boolean {
    if (equityPeak <= 0) return false;
    const dd = drawdownFrac(equityPeak, equityNow);
    return dd >= maxDrawdownFrac;
}

/** 
 * Compute the Exponential Moving Average (EMA) of an array of numbers.
 * @param arr - Array of numbers
 * @param period - The period over which to compute the EMA
 * @returns The EMA value
 */
export function ema(arr: number[], period: number): number {
    const k = 2 / (period + 1);
    let v = arr[0];
    for (let i = 1; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
    return v;
}

/**
 * Clamp a number between a lower and upper bound.
 * @param x - The number to clamp
 * @param lo - The lower bound
 * @param hi - The upper bound
 * @returns The clamped number
 */
function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

/**
 * Determine the reasons why an order may not meet the threshold criteria.
 * @param deltaShares - The change in shares for the order
 * @param notional - The notional value of the order
 * @param cfg - Normalized configuration parameters
 * @param side - The side of the order (optional)
 * @returns A list of reasons why the order may not meet the threshold criteria
 */
export function orderThresholdReasons(
    deltaShares: number,
    notional: number,
    cfg: NormalizedConfig,
    side?: OrderSide
): string[] {
    const reasons: string[] = [];
    if (Math.abs(deltaShares) < cfg.minDeltaShares) reasons.push("min_shares");
    const applyMinNotional = !side || (side !== "SELL" && side !== "COVER");
    if (applyMinNotional && notional < cfg.minOrderNotional)
        reasons.push("min_notional");
    return reasons;
}

/**
 * Determine whether the current value is within a specified tolerance of the target value.
 * @param currentValue - The current value
 * @param targetValue - The target value
 * @param toleranceFrac - The tolerance fraction
 * @returns True if the current value is within the tolerance of the target value, false otherwise
 */ 
export function isWithinTolerance(
    currentValue: number,
    targetValue: number,
    toleranceFrac: number
): boolean {
    const targetAbs = Math.abs(targetValue);
    if (targetAbs <= 0) return false;
    const diff = Math.abs(currentValue - targetValue);
    return diff <= targetAbs * toleranceFrac;
}

/**
 * Determine whether a hold order is blocked based on the minimum hold ticks.
 * @param last - The last trade note
 * @param tick - The current tick
 * @param minHoldTicks - The minimum hold ticks
 * @param side - The side of the order
 * @returns An object indicating whether the hold is blocked and the number of ticks since the last trade
 */
export function holdBlocked(
    last: TradeNote | undefined,
    tick: number,
    minHoldTicks: number,
    side: OrderSide
): { blocked: boolean; ticksSince: number } {
    // Deprecated alias – use tradeIntervalBlocked. Kept for backward compatibility with tests/users.
    return tradeIntervalBlocked(last, tick, minHoldTicks);
}

/**
 * Determine whether a trade interval is blocked based on the minimum trade interval ticks.
 * @param last - The last trade note
 * @param tick - The current tick
 * @param minTradeIntervalTicks - The minimum trade interval ticks
 * @returns An object indicating whether the trade interval is blocked and the number of ticks since the last trade
 */
export function tradeIntervalBlocked(
    last: TradeNote | undefined,
    tick: number,
    minTradeIntervalTicks: number
): { blocked: boolean; ticksSince: number } {
    if (!last) return { blocked: false, ticksSince: Infinity };
    const ticksSince = tick - last.tick;
    if (ticksSince >= minTradeIntervalTicks) return { blocked: false, ticksSince };
    return { blocked: true, ticksSince };
}

/**
 * Determine the reason why a spread signal may not meet the threshold criteria.
 * @param spreadFrac - The spread fraction
 * @param signalFrac - The signal fraction
 * @param cfg - Normalized configuration parameters
 * @returns A string indicating the reason why the spread signal may not meet the threshold criteria, or null if it does
 */
export function spreadSignalReason(
    spreadFrac: number,
    signalFrac: number | undefined,
    cfg: NormalizedConfig
): string | null {
    if (signalFrac === undefined || signalFrac < cfg.minSignalFrac)
        return "signal_too_weak";
    if (signalFrac < spreadFrac + cfg.spreadEdgeBufferFrac) return "spread";
    return null;
}
