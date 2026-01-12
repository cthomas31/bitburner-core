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
import { readJSON, writeJSON } from "/lib/ns-io.js";
import type { ControllerState } from "/bin/controller.js";

const STATE_FILE = "/data/stocks/state.json";

// ============== Type Definitions ==============

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

interface NormalizedConfig {
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

interface PriceEntry {
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

interface SymbolSnapshot {
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

interface Desire {
    dir: "LONG" | "SHORT";
    targetShares: number;
    score: number;
}

interface ScoredCandidate {
    sym: string;
    dir: "LONG" | "SHORT";
    score: number;
    targetShares: number;
}

export interface StockManager {
    name: string;
    init(ns: NS, ctrl: ControllerState): Promise<void>;
    tick(ns: NS, ctrl: ControllerState, now: number): Promise<void>;
    status(ctrl: ControllerState): string[];
}

// ============== Main Factory ==============

export function makeStockManager(config: StockManagerConfig = {}): StockManager {
    const cfg = normalizeConfig(config);

    return {
        name: "stocks",

        async init(ns: NS, ctrl: ControllerState): Promise<void> {
            if (!hasStockApis(ns)) {
                ctrl.stock = { enabled: false, reason: "NO_STOCK_APIS", lastRebalance: 0, cooldownUntil: {}, prices: {}, entry: {}, lastStatus: "", lastMode: "(unknown)" };
                return;
            }

            const st = (await readJSON(ns, STATE_FILE)) as Partial<StockState> | null ?? {};

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
            };
        },

        async tick(ns: NS, ctrl: ControllerState, now: number): Promise<void> {
            if (!ctrl.stock?.enabled) return;

            // throttle
            if (now - (ctrl.stock.lastRebalance ?? 0) < cfg.rebalanceMs) return;

            const symbols = ns.stock.getSymbols();

            // Determine whether we have 4S
            const have4S = cfg.use4S && has4SData(ns);
            ctrl.stock.lastMode = have4S ? "4S-forecast" : "trend-ema";

            // Build a snapshot and update price history
            const snapshot = symbols.map(sym => readSym(ns, sym, ctrl.stock as StockState, now, have4S, cfg));

            const equity = estimateEquity(ns, snapshot);
            const cash = ns.getServerMoneyAvailable("home");

            // Hard cash buffer
            const minCash = Math.max(cfg.minCashAbs, equity * cfg.minCashFrac);
            if (cash < minCash) {
                ctrl.stock.lastStatus = `cash below buffer (${fmt(cash)} < ${fmt(minCash)})`;
                ctrl.stock.lastRebalance = now;
                await persist(ns, ctrl.stock, cfg);
                return;
            }

            // Build desired positions
            const desires = have4S
                ? computeForecastDesires(snapshot, equity, cfg)
                : computeTrendDesires(snapshot, equity, cfg);

            // Do bounded actions per tick: exits first, then entries/resizes
            let actions = 0;

            // 1) Exits / reversals
            for (const sym of symbols) {
                if (actions >= cfg.maxActionsPerTick) break;

                const cd = ctrl.stock.cooldownUntil?.[sym] ?? 0;
                if (now < cd) continue;

                const pos = ns.stock.getPosition(sym); // [longShares, longPx, shortShares, shortPx]
                const longShares = pos[0], shortShares = pos[2];

                const want = desires.get(sym) ?? null; // {dir, targetShares, score}

                // Sell long if we no longer want long
                if (longShares > 0 && (!want || want.dir !== "LONG")) {
                    ns.stock.sellStock(sym, longShares);
                    setCooldown(ctrl.stock, sym, now, cfg.cooldownMs);
                    actions++;
                    continue;
                }

                // Cover short if we no longer want short
                if (shortShares > 0 && (!want || want.dir !== "SHORT")) {
                    if (typeof ns.stock.sellShort === "function") {
                        ns.stock.sellShort(sym, shortShares);
                    }
                    setCooldown(ctrl.stock, sym, now, cfg.cooldownMs);
                    actions++;
                    continue;
                }
            }

            // 2) Entries / resizing
            const openCount = countOpenPositions(ns, symbols);
            for (const [sym, want] of rankDesires(desires)) {
                if (actions >= cfg.maxActionsPerTick) break;

                const cd = ctrl.stock.cooldownUntil?.[sym] ?? 0;
                if (now < cd) continue;

                const pos = ns.stock.getPosition(sym);
                const longShares = pos[0], shortShares = pos[2];

                // Enforce max open symbols for new positions
                const isNew = (want.dir === "LONG" && longShares === 0) || (want.dir === "SHORT" && shortShares === 0);
                if (isNew && openCount >= cfg.maxOpenSymbols) continue;

                if (want.dir === "LONG") {
                    const buyMore = Math.max(0, want.targetShares - longShares);
                    if (buyMore > 0) {
                        ns.stock.buyStock(sym, buyMore);
                        setCooldown(ctrl.stock, sym, now, cfg.cooldownMs);
                        actions++;
                    }
                } else if (want.dir === "SHORT") {
                    // Use buyShort which is the actual Bitburner API name
                    if (typeof ns.stock.buyShort !== "function") continue; // shorts not available yet

                    const shortMore = Math.max(0, want.targetShares - shortShares);
                    if (shortMore > 0) {
                        ns.stock.buyShort(sym, shortMore);
                        setCooldown(ctrl.stock, sym, now, cfg.cooldownMs);
                        actions++;
                    }
                }
            }

            ctrl.stock.lastRebalance = now;
            ctrl.stock.lastStatus = `rebalance ok: mode=${ctrl.stock.lastMode} actions=${actions} equity=${fmt(equity)} cash=${fmt(cash)} desires=${desires.size}`;

            await persist(ns, ctrl.stock, cfg);
        },

        status(ctrl: ControllerState): string[] {
            if (!ctrl.stock) return ["stocks: (not init)"];
            if (!ctrl.stock.enabled) return [`stocks: disabled (${ctrl.stock.reason})`];

            // We avoid calling ns here since controller may call status without ns in scope.
            return [
                `stocks: enabled mode=${ctrl.stock.lastMode}`,
                `stocks: last=${new Date(ctrl.stock.lastRebalance).toLocaleTimeString()} status=${ctrl.stock.lastStatus}`,
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

        // If true, auto-upgrade to forecast mode when 4S is available
        use4S: c.use4S ?? true,

        // 4S forecast entries/exits (hysteresis)
        enterLong: c.enterLong ?? 0.60,
        exitLong: c.exitLong ?? 0.55,
        enterShort: c.enterShort ?? 0.40,
        exitShort: c.exitShort ?? 0.45,

        // trend mode parameters
        priceHistoryMax: c.priceHistoryMax ?? 80,
        emaFast: c.emaFast ?? 6,
        emaSlow: c.emaSlow ?? 24,
        trendEnter: c.trendEnter ?? 0.002, // 0.2%
        trendExit: c.trendExit ?? 0.000,  // cross-back

        // sizing
        maxSymbolFrac: c.maxSymbolFrac ?? 0.10,
        maxTotalFrac: c.maxTotalFrac ?? 0.80,
        maxOpenSymbols: c.maxOpenSymbols ?? 8,

        // cash buffer
        minCashAbs: c.minCashAbs ?? 40_000_000,
        minCashFrac: c.minCashFrac ?? 0.10,
    };
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
        if (typeof ns.stock.has4SDataTIXAPI === "function") return ns.stock.has4SDataTIXAPI();
        // Fallbacks for other versions
        if (typeof ns.stock.has4SData === "function") return ns.stock.has4SData();
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
    let eq = ns.getServerMoneyAvailable("home");

    for (const s of snapshot) {
        // Mark-to-market long at bid
        eq += s.longShares * s.bid;

        // Mark-to-market short (approx): entry value - current value
        // PnL per share ~ (entry - currentAsk)
        // Equity impact: cash already includes proceeds implicitly in BB? This is an approximation.
        if (s.shortShares > 0) {
            eq += s.shortShares * (s.shortPx - s.ask);
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
        const targetShares = clampInt(Math.floor(targetValue / Math.max(1, s.ask)), 0, s.maxShares);

        // Score by signal strength per volatility
        const score = absEdge / Math.max(1e-6, s.vol ?? 0.05);

        scored.push({ sym: s.sym, dir, score, targetShares });
    }

    scored.sort((a, b) => b.score - a.score);

    return capDesires(scored, cfg);
}

function computeTrendDesires(
    snapshot: SymbolSnapshot[],
    equity: number,
    cfg: NormalizedConfig
): Map<string, Desire> {
    const scored: ScoredCandidate[] = [];

    for (const s of snapshot) {
        const hist = s.history ?? [];
        if (hist.length < cfg.emaSlow) continue;

        const prices = hist.map(x => x.p);
        const fast = ema(prices, cfg.emaFast);
        const slow = ema(prices, cfg.emaSlow);

        const delta = (fast - slow) / slow; // relative difference

        const holdingLong = s.longShares > 0;
        const holdingShort = s.shortShares > 0;

        let dir: "LONG" | "SHORT" | null = null;

        if (holdingLong) {
            if (delta <= cfg.trendExit) dir = null;
            else dir = "LONG";
        } else if (holdingShort) {
            if (delta >= -cfg.trendExit) dir = null;
            else dir = "SHORT";
        } else {
            if (delta >= cfg.trendEnter) dir = "LONG";
            else if (delta <= -cfg.trendEnter) dir = "SHORT";
        }

        if (!dir) continue;

        // Trend mode is weaker signal: damp sizing
        const confidence = clamp(Math.abs(delta) / (cfg.trendEnter * 3), 0, 1);
        const targetFrac = (cfg.maxSymbolFrac * 0.60) * confidence;
        const targetValue = equity * targetFrac;
        const targetShares = clampInt(Math.floor(targetValue / Math.max(1, s.ask)), 0, s.maxShares);

        const score = Math.abs(delta);

        scored.push({ sym: s.sym, dir, score, targetShares });
    }

    scored.sort((a, b) => b.score - a.score);

    return capDesires(scored, cfg);
}

function capDesires(
    scored: ScoredCandidate[],
    cfg: NormalizedConfig
): Map<string, Desire> {
    // Enforce maxOpenSymbols and (lightly) total exposure cap
    const desires = new Map<string, Desire>();

    let open = 0;
    let usedFrac = 0;

    for (const c of scored) {
        if (open >= cfg.maxOpenSymbols) break;

        // Approx exposure as fraction of max per symbol. This is intentionally conservative.
        const frac = cfg.maxSymbolFrac;
        if (usedFrac + frac > cfg.maxTotalFrac) continue;

        desires.set(c.sym, { dir: c.dir, targetShares: c.targetShares, score: c.score });
        usedFrac += frac;
        open++;
    }

    return desires;
}

function rankDesires(desires: Map<string, Desire>): [string, Desire][] {
    return [...desires.entries()].sort((a, b) => (b[1].score ?? 0) - (a[1].score ?? 0));
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
        if (arr.length > cfg.priceHistoryMax) prices[sym] = arr.slice(-cfg.priceHistoryMax);
    }

    const toSave = {
        lastRebalance: stockState.lastRebalance ?? 0,
        cooldownUntil: stockState.cooldownUntil ?? {},
        prices,
        entry: stockState.entry ?? {},
    };

    await writeJSON(ns, STATE_FILE, toSave);
}

// ============== Math / Utils ==============

function ema(arr: number[], period: number): number {
    const k = 2 / (period + 1);
    let v = arr[0];
    for (let i = 1; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
    return v;
}

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
