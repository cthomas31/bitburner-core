// /lib/stockManager.ts
// BN8-ready stock trader that works WITH or WITHOUT 4S data.
//
// Modes:
// - If 4S Market Data TIX API is available (ns.stock.has4SDataTIXAPI()), use forecast/volatility strategy.
// - Otherwise, fall back to trend strategy using EMA crossover from locally maintained price history.
//
// Controller-friendly interface:
//   const stockMgr = makeStockManager({...});
//   await stockMgr.init(ns, ctrl);
//   await stockMgr.tick(ns, ctrl, Date.now());
//   for (const line of stockMgr.status(ctrl)) ns.print(line);

import type { NS } from "@ns";
import { readJSON, writeJSON } from "/lib/ns/io.js";
import {
    StockManagerConfig,
    StockState,
    NormalizedConfig,
    SymbolSnapshot,
    Desire,
    ScoredCandidate,
    TrendDebug,
} from "/domain/stocks/types.js";
import type { ControllerState } from "/domain/controller/types.js";
import {
    capDesires,
    computeTrendDesires,
    drawdownFrac,
    shouldKillOnDrawdown,
} from "/app/stocks/logic.js";
import { StockLogger } from "/domain/stocks/logger.js";

const STATE_FILE = "/data/stocks/state.json";

export interface StockManager {
    name: string;
    init(ns: NS, ctrl: ControllerState): Promise<void>;
    tick(ns: NS, ctrl: ControllerState, now: number): Promise<void>;
    status(ctrl: ControllerState): string[];
}

// ============== Main Factory ==============

export function makeStockManager(
    config: StockManagerConfig = {}
): StockManager {
    const cfg = normalizeConfig(config);

    return {
        name: "stocks",

        async init(ns: NS, ctrl: ControllerState): Promise<void> {
            if (!hasStockApis(ns)) {
                ctrl.stock = {
                    enabled: false,
                    reason: "NO_STOCK_APIS",
                    lastRebalance: 0,
                    cooldownUntil: {},
                    prices: {},
                    entry: {},
                    lastStatus: "",
                    lastMode: "(unknown)",
                    equityPeak: 0,
                    pausedUntil: 0,
                    tick: 0,
                    runId: "none",
                    logger: new StockLogger(ns, "none", { file: "/dev/null" }),
                };
                return;
            }

            const st =
                ((await readJSON(
                    ns,
                    STATE_FILE
                )) as Partial<StockState> | null) ?? {};

            const runId = mkRunId();
            ctrl.stock = {
                enabled: true,
                lastRebalance: st.lastRebalance ?? 0,
                cooldownUntil: st.cooldownUntil ?? {}, // sym -> ms

                // Trend mode history store: sym -> [{t,p}, ...]
                prices: st.prices ?? {},

                // Optional: track entry basis (not required for this strategy)
                entry: st.entry ?? {},

                lastStatus: "",
                lastMode: "(unknown)",

                equityPeak: st.equityPeak ?? 0,
                pausedUntil: st.pausedUntil ?? 0,

                tick: 0,
                runId: runId,
                logger: new StockLogger(ns, runId, { file: cfg.logFile }),
            };

            logEvent(ns, ctrl.stock, "info", "boot", {
                version: "stockmgr@1",
                cash: ns.getServerMoneyAvailable("home"),
                equityPeak: ctrl.stock.equityPeak,
                resumed: !!st.lastRebalance,
                runId: runId,
            });
        },

        async tick(ns: NS, ctrl: ControllerState, now: number): Promise<void> {
            if (!ctrl.stock?.enabled) return;

            // throttle
            if (now - (ctrl.stock.lastRebalance ?? 0) < cfg.rebalanceMs) return;

            // Logical tick: counts actual rebalance passes (not scheduler calls).
            const tick = bumpTick(ctrl.stock);

            const symbols = ns.stock.getSymbols();

            // Determine whether we have 4S
            const have4S = cfg.use4S && has4SData(ns);
            ctrl.stock.lastMode = have4S ? "4S-forecast" : "trend-ema";

            // Build a snapshot and update price history
            const snapshot = symbols.map((sym) =>
                readSym(ns, sym, ctrl.stock as StockState, now, have4S, cfg)
            );

            const equity = estimateEquity(ns, snapshot);
            const cash = ns.getServerMoneyAvailable("home");

            logEvent(ns, ctrl.stock, "info", "rebalance_start", {
                tick,
                mode: ctrl.stock.lastMode,
                have4S,
                cash,
                equity,
                equityPeak: ctrl.stock.equityPeak,
                pausedUntil: ctrl.stock.pausedUntil ?? null,
                openSymbols: countOpenPositions(ns, symbols),
            });

            // pause if killed recently
            if ((ctrl.stock.pausedUntil ?? 0) > now) {
                ctrl.stock.lastStatus = `paused after drawdown until ${new Date(
                    ctrl.stock.pausedUntil
                ).toLocaleTimeString()}`;
                ctrl.stock.lastRebalance = now;
                await persist(ns, ctrl.stock, cfg);
                logEvent(ns, ctrl.stock, "info", "paused", {
                    tick,
                    pausedUntil: ctrl.stock.pausedUntil,
                    cash,
                    equity,
                });
                return;
            }

            // update peak + check drawdown
            ctrl.stock.equityPeak = Math.max(
                ctrl.stock.equityPeak ?? 0,
                equity
            );
            const dd = drawdownFrac(ctrl.stock.equityPeak, equity);
            if (
                shouldKillOnDrawdown(
                    ctrl.stock.equityPeak,
                    equity,
                    cfg.maxDrawdownFrac
                )
            ) {
                const peakBefore = ctrl.stock.equityPeak;
                // liquidate everything, pause
                liquidateAll(ns, ctrl.stock, symbols);
                const cashAfter = ns.getServerMoneyAvailable("home");
                ctrl.stock.equityPeak = cashAfter; // reset peak baseline after kill
                ctrl.stock.pausedUntil = now + cfg.pauseAfterKillMs;
                ctrl.stock.lastStatus = `KILL SWITCH: drawdown ${(
                    dd * 100
                ).toFixed(1)}% -> liquidated + paused`;
                ctrl.stock.lastRebalance = now;
                await persist(ns, ctrl.stock, cfg);

                logEvent(ns, ctrl.stock, "warn", "risk_kill", {
                    tick,
                    mode: ctrl.stock.lastMode,
                    drawdownFrac: dd,
                    cashBefore: cash,
                    cashAfter,
                    equityBefore: equity,
                    equityPeakBefore: peakBefore,
                    pausedUntil: ctrl.stock.pausedUntil,
                    reason: "max_drawdown",
                });
                ctrl.stock.logger.flush();
                return;
            }

            // Hard cash buffer
            const minCash = cashFloor(ns, equity, cfg);
            if (cash < minCash) {
                ctrl.stock.lastStatus = `cash below buffer (${fmt(
                    cash
                )} < ${fmt(minCash)})`;
                ctrl.stock.lastRebalance = now;
                await persist(ns, ctrl.stock, cfg);
                ctrl.stock.logger.flush();
                return;
            }

            // Build desired positions
            let desires: Map<string, Desire>;
            let trendDebug: TrendDebug | null = null;

            if (have4S) {
                desires = computeForecastDesires(snapshot, equity, cfg);
            } else {
                const res = computeTrendDesires(snapshot, equity, cfg);
                desires = res.desires;
                trendDebug = res.debug;
            }

            // Do bounded actions per tick: exits first, then entries/resizes
            let actions = 0;

            // 1) Exits / reversals
            for (const sym of symbols) {
                if (actions >= cfg.maxActionsPerTick) break;

                const cd = ctrl.stock.cooldownUntil?.[sym] ?? 0;
                if (now < cd) continue;

                const pos = ns.stock.getPosition(sym); // [longShares, longPx, shortShares, shortPx]
                const longShares = pos[0],
                    shortShares = pos[2];

                const want = desires.get(sym) ?? null; // {dir, targetShares, score}

                // Sell long if we no longer want long
                if (longShares > 0 && (!want || want.dir !== "LONG")) {
                    execOrder(ns, ctrl.stock, symbols, "SELL", sym, longShares);
                    setCooldown(ctrl.stock, sym, now, cfg.cooldownMs);
                    actions++;
                    continue;
                }

                // Cover short if we no longer want short
                if (shortShares > 0 && (!want || want.dir !== "SHORT")) {
                    execOrder(ns, ctrl.stock, symbols, "COVER", sym, shortShares);
                    setCooldown(ctrl.stock, sym, now, cfg.cooldownMs);
                    actions++;
                    continue;
                }
            }

            // 2) Entries / resizing
            let openCount = countOpenPositions(ns, symbols);
            for (const [sym, want] of rankDesires(desires)) {
                if (actions >= cfg.maxActionsPerTick) break;

                const cd = ctrl.stock.cooldownUntil?.[sym] ?? 0;
                if (now < cd) continue;

                const pos = ns.stock.getPosition(sym);
                const longShares = pos[0],
                    shortShares = pos[2];

                // Enforce max open symbols for new positions
                const isNew =
                    (want.dir === "LONG" && longShares === 0) ||
                    (want.dir === "SHORT" && shortShares === 0);
                if (isNew && openCount >= cfg.maxOpenSymbols) continue;

                if (want.dir === "LONG") {
                    const buyMore = Math.max(0, want.targetShares - longShares);
                    if (buyMore > 0) {
                        const floor = cashFloor(ns, equity, cfg);
                        const safeShares = maxAffordableLongShares(
                            ns,
                            sym,
                            buyMore,
                            floor
                        );
                        if (safeShares > 0) {
                            execOrder(ns, ctrl.stock, symbols, "BUY", sym, safeShares);
                            setCooldown(ctrl.stock, sym, now, cfg.cooldownMs);
                            actions++;
                            if (isNew) openCount++;
                        }
                    }
                } else if (want.dir === "SHORT") {
                    // Use buyShort which is the actual Bitburner API name
                    if (typeof ns.stock.buyShort !== "function") continue; // shorts not available yet

                    const shortMore = Math.max(
                        0,
                        want.targetShares - shortShares
                    );
                    if (shortMore > 0) {
                        execOrder(ns, ctrl.stock, symbols, "SHORT", sym, shortMore);
                        setCooldown(ctrl.stock, sym, now, cfg.cooldownMs);
                        actions++;
                        if (isNew) openCount++;
                    }
                }
            }

            const cashEnd = ns.getServerMoneyAvailable("home");
            const equityEnd = estimateEquityQuick(ns, symbols);
            ctrl.stock.lastRebalance = now;
            const debugStr = trendDebug
                ? ` dbg(total=${trendDebug.total} cand=${trendDebug.candidates}` +
                  ` skipSpread=${trendDebug.skipSpread}` +
                  ` spread=[${(trendDebug.minSpreadFrac * 100).toFixed(2)}% ${
                      trendDebug.minSpreadSym
                  }..${(trendDebug.maxSpreadFrac * 100).toFixed(2)}% ${
                      trendDebug.maxSpreadSym
                  } maxSpreadFrac=${cfg.maxSpreadFrac}]` +
                  ` skipMinP=${trendDebug.skipMinPrice}` +
                  ` skipHist=${trendDebug.skipHist}` +
                  ` skipSlow=${trendDebug.skipSlow}` +
                  ` skipDir=${trendDebug.skipNoDir}` +
                  ` skipLongOnly=${trendDebug.skipLongOnly}` +
                  ` skipShares=${trendDebug.skipTargetShares})`
                : "";

            ctrl.stock.lastStatus = `rebalance ok: mode=${
                ctrl.stock.lastMode
            } actions=${actions} equity=${fmt(equityEnd)} cash=${fmt(
                cashEnd
            )} desires=${desires.size}${debugStr}`;

            logEvent(ns, ctrl.stock, "info", "rebalance_end", {
                tick,
                mode: ctrl.stock.lastMode,
                actions,
                cashStart: cash,
                cashEnd,
                equityStart: equity,
                equityEnd,
                minCash: cashFloor(ns, equityEnd, cfg),
                desires: desires.size,
                openSymbols: countOpenPositions(ns, symbols),
            });

            await persist(ns, ctrl.stock, cfg);
            ctrl.stock.logger.flush();
        },

        status(ctrl: ControllerState): string[] {
            if (!ctrl.stock) return ["stocks: (not init)"];
            if (!ctrl.stock.enabled)
                return [`stocks: disabled (${ctrl.stock.reason})`];

            // We avoid calling ns here since controller may call status without ns in scope.
            return [
                `stocks: enabled mode=${ctrl.stock.lastMode}`,
                `stocks: last=${new Date(
                    ctrl.stock.lastRebalance
                ).toLocaleTimeString()} status=${ctrl.stock.lastStatus}`,
            ];
        },
    };
}

// ============== Config ==============

function normalizeConfig(c: StockManagerConfig): NormalizedConfig {
    return {
        // runtime
        rebalanceMs: c.rebalanceMs ?? 6000,
        cooldownMs: c.cooldownMs ?? 20000,
        maxActionsPerTick: c.maxActionsPerTick ?? 6,
        logFile: c.logFile ?? "/logs/stock-manager.txt",

        // If true, auto-upgrade to forecast mode when 4S is available
        use4S: c.use4S ?? true,

        // 4S forecast entries/exits (hysteresis)
        enterLong: c.enterLong ?? 0.6,
        exitLong: c.exitLong ?? 0.55,
        enterShort: c.enterShort ?? 0.4,
        exitShort: c.exitShort ?? 0.45,

        // trend mode parameters
        priceHistoryMax: c.priceHistoryMax ?? 80,
        emaFast: c.emaFast ?? 6,
        emaSlow: c.emaSlow ?? 24,
        trendEnter: c.trendEnter ?? 0.002, // 0.2%
        trendExit: c.trendExit ?? 0.0, // cross-back

        // sizing
        maxSymbolFrac: c.maxSymbolFrac ?? 0.1,
        maxTotalFrac: c.maxTotalFrac ?? 0.8,
        maxOpenSymbols: c.maxOpenSymbols ?? 8,

        // cash buffer
        minCashAbs: c.minCashAbs ?? 40_000_000,
        minCashFrac: c.minCashFrac ?? 0.1,

        // risk controls
        maxDrawdownFrac: c.maxDrawdownFrac ?? 0.15, // 15% drawdown kill-switch
        pauseAfterKillMs: c.pauseAfterKillMs ?? 5 * 60 * 1000,

        // trend mode clamps (no 4S)
        trendLongOnly: c.trendLongOnly ?? true,
        trendMaxSymbolFrac: c.trendMaxSymbolFrac ?? 0.02, // 2% per symbol
        trendMaxTotalFrac: c.trendMaxTotalFrac ?? 0.2, // 20% total exposure
        maxSpreadFrac: c.maxSpreadFrac ?? 0.003, // skip if spread > 0.3%
        minPrice: c.minPrice ?? 5_000, // skip cheap noisy tickers
    };
}

function cashFloor(ns: NS, equity: number, cfg: NormalizedConfig): number {
    // Maintain an operating cash buffer so the controller never bricks the run (critical in BN8).
    return Math.max(cfg.minCashAbs, equity * cfg.minCashFrac);
}

function maxAffordableLongShares(
    ns: NS,
    sym: string,
    wantShares: number,
    floorCash: number
): number {
    const cash = ns.getServerMoneyAvailable("home");
    const usable = Math.max(0, cash - floorCash);
    const ask = ns.stock.getAskPrice(sym);
    if (ask <= 0) return 0;
    const cap = Math.floor(usable / ask);
    return Math.max(0, Math.min(wantShares, cap));
}

// ============== Helpers ==============

type LogLevel = "debug" | "info" | "warn" | "error";

function mkRunId(): string {
    return `${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
}

function bumpTick(ctrlStock: StockState): number {
    ctrlStock.tick += 1;
    return ctrlStock.tick;
}

function logEvent(
    ns: NS,
    ctrlStock: StockState,
    level: LogLevel,
    event: string,
    fields: Record<string, unknown> = {}
): void {
    ctrlStock.logger.log(level, event, { tick: ctrlStock.tick, ...fields });
}

function posOf(ns: NS, sym: string) {
    const [longShares, longPx, shortShares, shortPx] = ns.stock.getPosition(sym);
    return { longShares, longPx, shortShares, shortPx };
}

function estimateEquityQuick(ns: NS, symbols: string[]): number {
    // Quick conservative equity: cash + longs@bid - shorts@ask
    let eq = ns.getServerMoneyAvailable("home");
    for (const sym of symbols) {
        const [l, , sh] = ns.stock.getPosition(sym);
        if (l > 0) eq += ns.stock.getBidPrice(sym) * l;
        if (sh > 0) eq -= ns.stock.getAskPrice(sym) * sh;
    }
    return eq;
}

type OrderSide = "BUY" | "SELL" | "SHORT" | "COVER";

function execOrder(
    ns: NS,
    ctrlStock: StockState,
    symbols: string[],
    side: OrderSide,
    sym: string,
    sharesReq: number
): void {
    const cashBefore = ns.getServerMoneyAvailable("home");
    const equityBefore = estimateEquityQuick(ns, symbols);
    const p0 = posOf(ns, sym);
    const bid = ns.stock.getBidPrice(sym);
    const ask = ns.stock.getAskPrice(sym);

    let ret: number | null = null;
    try {
        switch (side) {
            case "BUY":
                ret = ns.stock.buyStock(sym, sharesReq);
                break;
            case "SELL":
                ret = ns.stock.sellStock(sym, sharesReq);
                break;
            case "SHORT":
                if (typeof ns.stock.buyShort !== "function") return;
                ret = ns.stock.buyShort(sym, sharesReq);
                break;
            case "COVER":
                if (typeof ns.stock.sellShort !== "function") return;
                ret = ns.stock.sellShort(sym, sharesReq);
                break;
        }
    } catch (e) {
        logEvent(ns, ctrlStock, "error", "order_error", {
            sym,
            side,
            sharesReq,
            bid,
            ask,
            err: String(e),
        });
        return;
    }

    const cashAfter = ns.getServerMoneyAvailable("home");
    const equityAfter = estimateEquityQuick(ns, symbols);
    const p1 = posOf(ns, sym);

    logEvent(ns, ctrlStock, "info", "order", {
        sym,
        side,
        sharesReq,
        ret,
        bid,
        ask,
        cashBefore,
        cashAfter,
        equityBefore,
        equityAfter,
        posBefore: p0,
        posAfter: p1,
        deltaLong: p1.longShares - p0.longShares,
        deltaShort: p1.shortShares - p0.shortShares,
    });
}

function liquidateAll(ns: NS, ctrlStock: StockState, symbols: string[]): void {
    for (const sym of symbols) {
        const [l, , sh] = ns.stock.getPosition(sym);
        if (l > 0) execOrder(ns, ctrlStock, symbols, "SELL", sym, l);
        if (sh > 0) execOrder(ns, ctrlStock, symbols, "COVER", sym, sh);
    }
}

// ============== API Detection ==============

function hasStockApis(ns: NS): boolean {
    try {
        return !!ns && !!ns.stock && typeof ns.stock.getSymbols === "function";
    } catch {
        return false;
    }
}

function has4SData(ns: NS): boolean {
    try {
        if (!ns || !ns.stock) return false;
        // User confirmed this exists in their build
        if (typeof ns.stock.has4SDataTIXAPI === "function")
            return ns.stock.has4SDataTIXAPI();
        // Fallbacks for other versions
        if (typeof ns.stock.has4SData === "function")
            return ns.stock.has4SData();
        return false;
    } catch {
        return false;
    }
}

// ============== Snapshot / State ==============

function readSym(
    ns: NS,
    sym: string,
    stockState: StockState,
    now: number,
    have4S: boolean,
    cfg: NormalizedConfig
): SymbolSnapshot {
    const bid = ns.stock.getBidPrice(sym);
    const ask = ns.stock.getAskPrice(sym);
    const price = (bid + ask) / 2;

    // Maintain local history for trend mode
    if (!stockState.prices) stockState.prices = {};
    if (!stockState.prices[sym]) stockState.prices[sym] = [];
    const arr = stockState.prices[sym];
    arr.push({ t: now, p: price });
    while (arr.length > cfg.priceHistoryMax) arr.shift();

    const pos = ns.stock.getPosition(sym);

    let forecast: number | null = null;
    let vol: number | null = null;
    if (have4S) {
        forecast = ns.stock.getForecast(sym);
        vol = ns.stock.getVolatility(sym);
    }

    return {
        sym,
        bid,
        ask,
        price,

        forecast,
        vol,

        longShares: pos[0],
        longPx: pos[1],
        shortShares: pos[2],
        shortPx: pos[3],

        maxShares: ns.stock.getMaxShares(sym),
        history: arr,
    };
}

function estimateEquity(ns: NS, snapshot: SymbolSnapshot[]): number {
    // Conservative mark-to-market equity estimate.
    // Longs valued at bid; shorts valued as unrealized P/L using entry shortPx vs current ask.
    // (Commission ignored here; it is handled as churn control elsewhere.)
    let eq = ns.getServerMoneyAvailable("home");

    for (const s of snapshot) {
        if (s.longShares > 0) {
            eq += s.bid * s.longShares;
        }
        if (s.shortShares > 0) {
            eq -= s.ask * s.shortShares;
        }
    }
    return eq;
}

// ============== Decision Logic ==============

function computeForecastDesires(
    snapshot: SymbolSnapshot[],
    equity: number,
    cfg: NormalizedConfig
): Map<string, Desire> {
    const scored: ScoredCandidate[] = [];

    for (const s of snapshot) {
        if (s.forecast === null) continue;

        const edge = s.forecast - 0.5;
        const absEdge = Math.abs(edge);

        const holdingLong = s.longShares > 0;
        const holdingShort = s.shortShares > 0;

        let dir: "LONG" | "SHORT" | null = null;

        // Hysteresis-based direction
        if (holdingLong) {
            if (s.forecast <= cfg.exitLong) dir = null;
            else dir = "LONG";
        } else if (holdingShort) {
            if (s.forecast >= cfg.exitShort) dir = null;
            else dir = "SHORT";
        } else {
            if (s.forecast >= cfg.enterLong) dir = "LONG";
            else if (s.forecast <= cfg.enterShort) dir = "SHORT";
        }

        if (!dir) continue;

        // Sizing: confidence + volatility penalty
        const confidence = clamp(absEdge / 0.15, 0, 1);
        const volPenalty = clamp((s.vol ?? 0.05) / 0.05, 0.5, 2.0);

        const targetFrac = (cfg.maxSymbolFrac * confidence) / volPenalty;
        const targetValue = equity * targetFrac;
        const targetShares = clampInt(
            Math.floor(targetValue / Math.max(1, s.ask)),
            0,
            s.maxShares
        );

        // Score by signal strength per volatility
        const score = absEdge / Math.max(1e-6, s.vol ?? 0.05);

        scored.push({ sym: s.sym, dir, score, targetShares });
    }

    scored.sort((a, b) => b.score - a.score);

    return capDesires(scored, cfg, cfg.maxSymbolFrac, cfg.maxTotalFrac);
}

function rankDesires(desires: Map<string, Desire>): [string, Desire][] {
    return [...desires.entries()].sort(
        (a, b) => (b[1].score ?? 0) - (a[1].score ?? 0)
    );
}

function countOpenPositions(ns: NS, symbols: string[]): number {
    let n = 0;
    for (const sym of symbols) {
        const p = ns.stock.getPosition(sym);
        if (p[0] > 0 || p[2] > 0) n++;
    }
    return n;
}

function setCooldown(
    stockState: StockState,
    sym: string,
    now: number,
    cooldownMs: number
): void {
    if (!stockState.cooldownUntil) stockState.cooldownUntil = {};
    stockState.cooldownUntil[sym] = now + cooldownMs;
}

async function persist(
    ns: NS,
    stockState: StockState,
    cfg: NormalizedConfig
): Promise<void> {
    // Trim price history so state doesn't bloat
    const prices = stockState.prices ?? {};
    for (const sym of Object.keys(prices)) {
        const arr = prices[sym] ?? [];
        if (arr.length > cfg.priceHistoryMax)
            prices[sym] = arr.slice(-cfg.priceHistoryMax);
    }

    const toSave = {
        lastRebalance: stockState.lastRebalance ?? 0,
        cooldownUntil: stockState.cooldownUntil ?? {},
        prices,
        entry: stockState.entry ?? {},
        equityPeak: stockState.equityPeak ?? 0,
        pausedUntil: stockState.pausedUntil ?? 0,
    };

    writeJSON(ns, STATE_FILE, toSave);
}

// ============== Math / Utils ==============

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}

function clampInt(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x | 0));
}

function fmt(n: number): string {
    if (n >= 1e12) return (n / 1e12).toFixed(2) + "t";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "b";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "m";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "k";
    return String(Math.floor(n));
}
