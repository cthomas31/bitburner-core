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
    OrderSide,
    SymbolPositionState,
    PositionMode,
} from "/domain/stocks/types.js";
import type { ControllerState } from "/domain/controller/types.js";
import {
    capDesires,
    computeTrendDesires,
    drawdownFrac,
    isWithinTolerance,
    orderThresholdReasons,
    spreadSignalReason,
    shouldKillOnDrawdown,
    tradeIntervalBlocked,
} from "/app/stocks/logic.js";
import { StockLogger } from "/domain/stocks/logger.js";

const STATE_FILE = "/data/stocks/state.json";

type Verbosity = "quiet" | "normal" | "debug";

type ActionKind = "EXIT" | "ENTER";

type CandidateAction = {
    sym: string;
    side: OrderSide;
    kind: ActionKind;
    exec: () => void;
};

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

    const verbosity: Verbosity = cfg.logVerbosity;

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
                    logger: new StockLogger(ns, "none", {
                        file: "/dev/null",
                        minLevel: verbosity === "debug" ? "debug" : "info",
                    }),
                    logVerbosity: verbosity,
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
                positionsBySymbol: st.positionsBySymbol ?? {}, // sym -> position state

                // Trend mode history store: sym -> [{t,p}, ...]
                prices: st.prices ?? {},

                // Optional: track entry basis (not required for this strategy)
                entry: st.entry ?? {},

                lastStatus: "",
                lastMode: "(unknown)",

                equityPeak: st.equityPeak ?? 0,
                pausedUntil: st.pausedUntil ?? 0,

                tick: st.tick ?? 0,
                runId: runId,
                logger: new StockLogger(ns, runId, {
                    file: cfg.logFile,
                    minLevel: verbosity === "debug" ? "debug" : "info",
                }),
                logVerbosity: verbosity,
                lastTrade: st.lastTrade ?? {},
                executedOrdersPrevTick: st.executedOrdersPrevTick ?? 0,
            };

            if (cfg.legacyMinHoldTicks !== undefined) {
                logEvent(ns, ctrl.stock, "warn", "config_deprecated", verbosity, {
                    key: "stocks.minHoldTicks",
                    mappedTo: [
                        "stocks.minHoldAfterEntryTicks",
                        "stocks.minTradeIntervalTicks",
                    ],
                    value: cfg.legacyMinHoldTicks,
                });
            }

            if (cfg.legacyCooldownMs !== undefined) {
                logEvent(ns, ctrl.stock, "warn", "config_deprecated", verbosity, {
                    key: "stocks.cooldownMs",
                    mappedTo: "stocks.cooldownTicks",
                    cooldownMs: cfg.legacyCooldownMs,
                    rebalanceMs: cfg.rebalanceMs,
                    derivedCooldownTicks: cfg.cooldownTicks,
                });
            }

            if (cfg.resetEquityPeakOnBoot) {
                const symbols = ns.stock.getSymbols();
                const equityNow = estimateEquityQuick(ns, symbols);
                ctrl.stock.equityPeak = equityNow;
                logEvent(ns, ctrl.stock, "info", "equity_peak_reset_boot", verbosity, {
                    tick: ctrl.stock.tick,
                    equity: equityNow,
                });
            }

            enforceHysteresis(ns, ctrl.stock, cfg);

            logEvent(ns, ctrl.stock, "info", "boot", verbosity, {
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
            const snapshotBySym = new Map(snapshot.map((s) => [s.sym, s]));
            const skipCounts: Record<string, number> = {};
            const orderStats = {
                spreadCost: 0,
                commission: 0,
                realizedPnL: 0,
                orders: 0,
            };
            let executedOrdersThisTick = 0;
            const recordSkip = (reason: string) => {
                skipCounts[reason] = (skipCounts[reason] ?? 0) + 1;
            };

            syncPositionStates(ctrl.stock as StockState, snapshot, tick);

            const evaluatedThisTick = new Set<string>();

            const equity = estimateEquity(ns, snapshot);
            const cash = ns.getServerMoneyAvailable("home");

            logEvent(ns, ctrl.stock, "info", "rebalance_start", verbosity, {
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
                ctrl.stock.executedOrdersPrevTick = executedOrdersThisTick;
                await persist(ns, ctrl.stock, cfg);
                logEvent(ns, ctrl.stock, "info", "paused", verbosity, {
                    tick,
                    pausedUntil: ctrl.stock.pausedUntil,
                    cash,
                    equity,
                });
                return;
            }

            const equityPeakBefore = ctrl.stock.equityPeak ?? 0;
            const executedPrevTick = ctrl.stock.executedOrdersPrevTick ?? 0;
            const equityDropFrac =
                equityPeakBefore > 0
                    ? (equityPeakBefore - equity) /
                      Math.max(equityPeakBefore, 1)
                    : 0;

            if (
                executedPrevTick === 0 &&
                equityPeakBefore > 0 &&
                equityDropFrac >= cfg.externalSpendResetFrac
            ) {
                ctrl.stock.equityPeak = equity;
                logEvent(
                    ns,
                    ctrl.stock,
                    "info",
                    "external_spend_reset",
                    verbosity,
                    {
                        tick,
                        equityPeakBefore,
                        equityNow: equity,
                        dropFrac: equityDropFrac,
                        threshold: cfg.externalSpendResetFrac,
                    }
                );
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
                logEvent(ns, ctrl.stock, "warn", "circuit_breaker", verbosity, {
                    tick,
                    mode: ctrl.stock.lastMode,
                    equity,
                    equityPeak: peakBefore,
                    drawdownFrac: dd,
                    pausedUntil: now + cfg.pauseAfterKillMs,
                    action: "liquidate",
                });
                // liquidate everything, pause
                const liquidatedOrders = liquidateAll(
                    ns,
                    ctrl.stock,
                    symbols,
                    cfg
                );
                executedOrdersThisTick = liquidatedOrders;
                const cashAfter = ns.getServerMoneyAvailable("home");
                ctrl.stock.equityPeak = cashAfter; // reset peak baseline after kill
                ctrl.stock.pausedUntil = now + cfg.pauseAfterKillMs;
                ctrl.stock.lastStatus = `KILL SWITCH: drawdown ${(
                    dd * 100
                ).toFixed(1)}% -> liquidated + paused`;
                ctrl.stock.lastRebalance = now;
                ctrl.stock.executedOrdersPrevTick = executedOrdersThisTick;
                await persist(ns, ctrl.stock, cfg);

                logEvent(ns, ctrl.stock, "warn", "risk_kill", verbosity, {
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
                ctrl.stock.executedOrdersPrevTick = executedOrdersThisTick;
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

            const candidates: CandidateAction[] = [];
            const perSymbolCandidate = new Map<string, CandidateAction>();
            const plannedSymbols = new Set<string>();
            const addCandidate = (cand: CandidateAction): boolean => {
                const existing = perSymbolCandidate.get(cand.sym);
                if (!existing) {
                    perSymbolCandidate.set(cand.sym, cand);
                    candidates.push(cand);
                    return true;
                }
                if (existing.kind === "EXIT") return false;
                if (cand.kind === "EXIT") {
                    perSymbolCandidate.set(cand.sym, cand);
                    const idx = candidates.indexOf(existing);
                    if (idx >= 0) candidates[idx] = cand;
                }
                return cand.kind === "EXIT";
            };

            // 1) Exits / reversals
            for (const sym of symbols) {
                const posState = ensurePositionState(
                    ctrl.stock as StockState,
                    sym
                );
                const gate = canEvaluateSymbol(
                    sym,
                    posState,
                    tick,
                    cfg,
                    evaluatedThisTick,
                    true
                );
                if (!gate.ok) {
                    recordSkip(gate.reason ?? "decision_interval");
                    logEvent(ns, ctrl.stock, "debug", "decision_skip", verbosity, {
                        sym,
                        reason: gate.reason,
                        tick,
                        lastDecisionTick: posState.lastDecisionTick ?? null,
                        cooldownUntilTick: posState.cooldownUntilTick ?? null,
                        decisionIntervalTicks: cfg.decisionIntervalTicks,
                    });
                    continue;
                }
                plannedSymbols.add(sym);

                const pos = ns.stock.getPosition(sym); // [longShares, longPx, shortShares, shortPx]
                const longShares = pos[0],
                    shortShares = pos[2];

                const want = desires.get(sym) ?? null; // {dir, targetShares, score}
                const snap = snapshotBySym.get(sym);
                const lastTrade = ctrl.stock.lastTrade?.[sym];
                const spreadFrac =
                    snap && snap.ask > 0
                        ? (snap.ask - snap.bid) /
                          Math.max(1, (snap.ask + snap.bid) / 2)
                        : 1;
                const enteredTick = posState.enteredTick ?? tick;

                // Sell long if we no longer want long
                if (longShares > 0 && (!want || want.dir !== "LONG")) {
                    if (
                        tick - enteredTick <
                        Math.max(0, cfg.minHoldAfterEntryTicks)
                    ) {
                        recordSkip("min_hold_after_entry");
                        logEvent(
                            ns,
                            ctrl.stock,
                            "debug",
                            "min_hold_after_entry_skip",
                            verbosity,
                            {
                                sym,
                                tick,
                                enteredTick,
                                minHoldAfterEntryTicks:
                                    cfg.minHoldAfterEntryTicks,
                            }
                        );
                        continue;
                    }

                    const tradeGate = tradeIntervalBlocked(
                        lastTrade,
                        tick,
                        cfg.minTradeIntervalTicks
                    );
                    if (tradeGate.blocked) {
                        recordSkip("min_trade_interval");
                        logEvent(
                            ns,
                            ctrl.stock,
                            "debug",
                            "trade_interval_skip",
                            verbosity,
                            {
                                sym,
                                intendedSide: "SELL",
                                ticksSinceLastTrade: tradeGate.ticksSince,
                                minTradeIntervalTicks:
                                    cfg.minTradeIntervalTicks,
                            }
                        );
                        continue;
                    }

                    const reasons = orderThresholdReasons(
                        longShares,
                        (snap?.bid ?? 0) * longShares,
                        cfg,
                        "SELL"
                    );
                    const spreadReason = want
                        ? spreadSignalReason(spreadFrac, want.signalFrac, cfg)
                        : null;
                    if (spreadReason) reasons.push(spreadReason);

                    if (reasons.length > 0) {
                        reasons.forEach(recordSkip);
                        logEvent(ns, ctrl.stock, "debug", "skip_order", verbosity, {
                            sym,
                            price: snap?.bid ?? 0,
                            notional: (snap?.bid ?? 0) * longShares,
                            minNotional: cfg.minOrderNotional,
                            deployableCash: cash - cashFloor(ns, equity, cfg),
                            side: "SELL",
                            sharesReq: longShares,
                            reasons,
                        });
                        continue;
                    }

                    addCandidate({
                        sym,
                        side: "SELL",
                        kind: "EXIT",
                        exec: () => {
                            execOrder(
                                ns,
                                ctrl.stock as StockState,
                                symbols,
                                "SELL",
                                sym,
                                longShares,
                                cfg,
                                orderStats
                            );
                        },
                    });
                    continue;
                }

                // Cover short if we no longer want short
                if (shortShares > 0 && (!want || want.dir !== "SHORT")) {
                    if (
                        tick - enteredTick <
                        Math.max(0, cfg.minHoldAfterEntryTicks)
                    ) {
                        recordSkip("min_hold_after_entry");
                        logEvent(
                            ns,
                            ctrl.stock,
                            "debug",
                            "min_hold_after_entry_skip",
                            verbosity,
                            {
                                sym,
                                tick,
                                enteredTick,
                                minHoldAfterEntryTicks:
                                    cfg.minHoldAfterEntryTicks,
                            }
                        );
                        continue;
                    }

                    const tradeGate = tradeIntervalBlocked(
                        lastTrade,
                        tick,
                        cfg.minTradeIntervalTicks
                    );
                    if (tradeGate.blocked) {
                        recordSkip("min_trade_interval");
                        logEvent(
                            ns,
                            ctrl.stock,
                            "debug",
                            "trade_interval_skip",
                            verbosity,
                            {
                                sym,
                                intendedSide: "COVER",
                                ticksSinceLastTrade: tradeGate.ticksSince,
                                minTradeIntervalTicks:
                                    cfg.minTradeIntervalTicks,
                            }
                        );
                        continue;
                    }

                    const reasons = orderThresholdReasons(
                        shortShares,
                        (snap?.ask ?? 0) * shortShares,
                        cfg,
                        "COVER"
                    );
                    const spreadReason = want
                        ? spreadSignalReason(spreadFrac, want.signalFrac, cfg)
                        : null;
                    if (spreadReason) reasons.push(spreadReason);
                    if (reasons.length > 0) {
                        reasons.forEach(recordSkip);
                        logEvent(ns, ctrl.stock, "debug", "skip_order", verbosity, {
                            sym,
                            side: "COVER",
                            price: snap?.ask ?? 0,
                            notional: (snap?.ask ?? 0) * shortShares,
                            minNotional: cfg.minOrderNotional,
                            deployableCash: cash - cashFloor(ns, equity, cfg),
                            sharesReq: shortShares,
                            reasons,
                        });
                        continue;
                    }

                    addCandidate({
                        sym,
                        side: "COVER",
                        kind: "EXIT",
                        exec: () => {
                            execOrder(
                                ns,
                                ctrl.stock as StockState,
                                symbols,
                                "COVER",
                                sym,
                                shortShares,
                                cfg,
                                orderStats
                            );
                        },
                    });
                    continue;
                }
            }

            // 2) Entries / resizing
            let openCount = countOpenPositions(ns, symbols);
            let grossExposure = grossExposureValue(ns, symbols);
            let equityForSizing = estimateEquityQuick(ns, symbols);
            let cashForSizing = ns.getServerMoneyAvailable("home");
            const perSymbolCap = have4S
                ? cfg.maxSymbolFrac
                : cfg.trendMaxSymbolFrac;
            const totalCap = have4S ? cfg.maxTotalFrac : cfg.trendMaxTotalFrac;
            for (const [sym, want] of rankDesires(desires)) {
                const posState = ensurePositionState(
                    ctrl.stock as StockState,
                    sym
                );
                const gate = canEvaluateSymbol(
                    sym,
                    posState,
                    tick,
                    cfg,
                    evaluatedThisTick,
                    true
                );
                if (!gate.ok) {
                    recordSkip(gate.reason ?? "decision_interval");
                    logEvent(ns, ctrl.stock, "debug", "decision_skip", verbosity, {
                        sym,
                        reason: gate.reason,
                        tick,
                        lastDecisionTick: posState.lastDecisionTick ?? null,
                        cooldownUntilTick: posState.cooldownUntilTick ?? null,
                        decisionIntervalTicks: cfg.decisionIntervalTicks,
                    });
                    continue;
                }
                plannedSymbols.add(sym);

                const pos = ns.stock.getPosition(sym);
                const longShares = pos[0],
                    shortShares = pos[2];
                const snap = snapshotBySym.get(sym);
                const spreadFrac =
                    snap && snap.ask > 0
                        ? (snap.ask - snap.bid) /
                          Math.max(1, (snap.ask + snap.bid) / 2)
                        : 1;
                const holdInfo = ctrl.stock.lastTrade?.[sym];

                // Friction / edge gate (entries only)
                // Enforce max open symbols for new positions
                const isNew =
                    (want.dir === "LONG" && longShares === 0) ||
                    (want.dir === "SHORT" && shortShares === 0);
                if (isNew && openCount >= cfg.maxOpenSymbols) continue;

                if (want.dir === "LONG") {
                    const isHoldingLong = longShares > 0;
                    if (isHoldingLong) {
                        if (
                            posState.targetLongShares === undefined ||
                            posState.targetLongShares <= 0
                        ) {
                            posState.targetLongShares = longShares;
                        }
                        if (want.targetShares > longShares) {
                            recordSkip("no_resize");
                            logEvent(
                                ns,
                                ctrl.stock,
                                "debug",
                                "resize_blocked",
                                verbosity,
                                {
                                    sym,
                                    longShares,
                                    lockedShares: posState.targetLongShares,
                                    desiredShares: want.targetShares,
                                }
                            );
                        }
                        continue;
                    }

                    // Flat -> entering long
                    const buyMore = Math.max(0, want.targetShares - longShares);
                    if (buyMore > 0) {
                        const tradeGate = tradeIntervalBlocked(
                            holdInfo,
                            tick,
                            cfg.minTradeIntervalTicks
                        );
                        if (tradeGate.blocked) {
                            recordSkip("min_trade_interval");
                            logEvent(
                                ns,
                                ctrl.stock,
                                "debug",
                                "trade_interval_skip",
                                verbosity,
                                {
                                    sym,
                                    intendedSide: "BUY",
                                    ticksSinceLastTrade: tradeGate.ticksSince,
                                    minTradeIntervalTicks:
                                        cfg.minTradeIntervalTicks,
                                }
                            );
                            continue;
                        }

                        const targetValue =
                            (snap?.ask ?? 0) * want.targetShares;
                        const currentValue = longShares * (snap?.bid ?? 0);
                        if (
                            isWithinTolerance(
                                currentValue,
                                targetValue,
                                cfg.positionToleranceFrac
                            )
                        ) {
                            recordSkip("tolerance");
                            logEvent(
                                ns,
                                ctrl.stock,
                                "debug",
                                "position_within_tolerance",
                                verbosity,
                                {
                                    sym,
                                    dir: "LONG",
                                    targetShares: want.targetShares,
                                    currentShares: longShares,
                                    toleranceFrac: cfg.positionToleranceFrac,
                                }
                            );
                            continue;
                        }

                        const priceUsed = snap?.ask ?? 0;
                        const minNotional = cfg.minOrderNotional;
                        const floor = cashFloor(ns, equityForSizing, cfg);
                        const deployableCash = Math.max(
                            0,
                            cashForSizing - floor
                        );
                        const minSharesToClear =
                            priceUsed > 0
                                ? Math.ceil(minNotional / priceUsed)
                                : 0;
                        const sharesComputed = buyMore;
                        const sharesBumpedTo =
                            priceUsed > 0 &&
                            sharesComputed * priceUsed < minNotional
                                ? Math.max(sharesComputed, minSharesToClear)
                                : sharesComputed;

                        const caps: { label: string; shares: number }[] = [];
                        const maxStockCap =
                            snap?.maxShares !== undefined
                                ? Math.max(0, snap.maxShares - longShares)
                                : Number.POSITIVE_INFINITY;
                        caps.push({ label: "max_shares", shares: maxStockCap });

                        const remainingSymbolValue = Math.max(
                            0,
                            equityForSizing * perSymbolCap -
                                priceUsed * longShares
                        );
                        caps.push({
                            label: "max_symbol_cap",
                            shares:
                                priceUsed > 0
                                    ? Math.floor(
                                          remainingSymbolValue / priceUsed
                                      )
                                    : 0,
                        });

                        const remainingTotalValue = Math.max(
                            0,
                            equityForSizing * totalCap - grossExposure
                        );
                        caps.push({
                            label: "max_total_cap",
                            shares:
                                priceUsed > 0
                                    ? Math.floor(remainingTotalValue / priceUsed)
                                    : 0,
                        });

                        caps.push({
                            label: "cash_floor",
                            shares:
                                priceUsed > 0
                                    ? Math.floor(deployableCash / priceUsed)
                                    : 0,
                        });

                        let sharesFinal = sharesBumpedTo;
                        let bindingConstraint: string | null = null;
                        for (const cap of caps) {
                            const capShares = Math.max(
                                0,
                                Math.floor(cap.shares)
                            );
                            if (capShares < sharesFinal) {
                                sharesFinal = capShares;
                                bindingConstraint = cap.label;
                            }
                        }
                        const sharesAffordableCap = sharesFinal;
                        const notionalFinal = priceUsed * sharesFinal;

                        const reasons = orderThresholdReasons(
                            sharesFinal,
                            notionalFinal,
                            cfg,
                            "BUY"
                        );
                        const spreadReason = spreadSignalReason(
                            spreadFrac,
                            want.signalFrac,
                            cfg
                        );
                        if (spreadReason) reasons.push(spreadReason);

                        if (reasons.includes("min_notional") && !bindingConstraint) {
                            bindingConstraint = "min_notional";
                        }

                        if (reasons.length > 0) {
                            reasons.forEach(recordSkip);
                            const logFields: Record<string, unknown> = {
                                sym,
                                price: priceUsed,
                                notional: notionalFinal,
                                minNotional,
                                deployableCash,
                                side: "BUY",
                                sharesReq: sharesFinal,
                                reasons,
                            };
                            if (reasons.includes("min_notional")) {
                                logFields.priceUsed = priceUsed;
                                logFields.sharesComputed = sharesComputed;
                                logFields.sharesBumpedTo = sharesBumpedTo;
                                logFields.sharesAffordableCap =
                                    sharesAffordableCap;
                                logFields.sharesFinal = sharesFinal;
                                logFields.notionalFinal = notionalFinal;
                                logFields.bindingConstraint =
                                    bindingConstraint ?? "min_notional";
                            }

                            logEvent(
                                ns,
                                ctrl.stock,
                                "debug",
                                "skip_order",
                                verbosity,
                                logFields
                            );
                            continue;
                        }

                        if (sharesFinal > 0) {
                            const frictionFrac = estimateFrictionFracForEntry(
                                ns,
                                snap,
                                sharesFinal,
                                "BUY",
                                cfg
                            );
                            const expectedEdgeFrac = have4S
                                ? Math.abs((snap?.forecast ?? 0) - 0.5)
                                : Math.abs(want.signalFrac ?? 0);
                            if (
                                expectedEdgeFrac <
                                frictionFrac + cfg.frictionMinEdgeFrac
                            ) {
                                recordSkip("friction_edge");
                                logEvent(
                                    ns,
                                    ctrl.stock,
                                    "debug",
                                    "friction_edge_skip",
                                    verbosity,
                                    {
                                        sym,
                                        edgeFrac: expectedEdgeFrac,
                                        frictionFrac,
                                        minEdgeFrac: cfg.frictionMinEdgeFrac,
                                        notional: priceUsed * sharesFinal,
                                        shares: sharesFinal,
                                    }
                                );
                                continue;
                            }

                            const added = addCandidate({
                                sym,
                                side: "BUY",
                                kind: "ENTER",
                                exec: () => {
                                    const posStateExec = ensurePositionState(
                                        ctrl.stock as StockState,
                                        sym
                                    );
                                    posStateExec.targetLongShares = sharesFinal;
                                    posStateExec.entryPrice = snap?.ask ?? undefined;
                                    execOrder(
                                        ns,
                                        ctrl.stock as StockState,
                                        symbols,
                                        "BUY",
                                        sym,
                                        sharesFinal,
                                        cfg,
                                        orderStats
                                    );
                                },
                            });
                            if (added) {
                                grossExposure += priceUsed * sharesFinal;
                                cashForSizing =
                                    ns.getServerMoneyAvailable("home");
                                equityForSizing = estimateEquityQuick(
                                    ns,
                                    symbols
                                );
                                if (isNew) openCount++;
                            }
                        }
                    }
                } else if (want.dir === "SHORT") {
                    // Use buyShort which is the actual Bitburner API name
                    if (typeof ns.stock.buyShort !== "function") continue; // shorts not available yet

                    const isHoldingShort = shortShares > 0;
                    if (isHoldingShort) {
                        if (
                            posState.targetShortShares === undefined ||
                            posState.targetShortShares <= 0
                        ) {
                            posState.targetShortShares = shortShares;
                        }
                        if (want.targetShares > shortShares) {
                            recordSkip("no_resize");
                            logEvent(
                                ns,
                                ctrl.stock,
                                "debug",
                                "resize_blocked",
                                verbosity,
                                {
                                    sym,
                                    shortShares,
                                    lockedShares: posState.targetShortShares,
                                    desiredShares: want.targetShares,
                                }
                            );
                        }
                        continue;
                    }

                    const shortMore = Math.max(
                        0,
                        want.targetShares - shortShares
                    );
                    if (shortMore > 0) {
                        const tradeGate = tradeIntervalBlocked(
                            holdInfo,
                            tick,
                            cfg.minTradeIntervalTicks
                        );
                        if (tradeGate.blocked) {
                            recordSkip("min_trade_interval");
                            logEvent(
                                ns,
                                ctrl.stock,
                                "debug",
                                "trade_interval_skip",
                                verbosity,
                                {
                                    sym,
                                    intendedSide: "SHORT",
                                    ticksSinceLastTrade: tradeGate.ticksSince,
                                    minTradeIntervalTicks:
                                        cfg.minTradeIntervalTicks,
                                }
                            );
                            continue;
                        }

                        const targetValue =
                            (snap?.bid ?? 0) * want.targetShares;
                        const currentValue = shortShares * (snap?.ask ?? 0);
                        if (
                            isWithinTolerance(
                                currentValue,
                                targetValue,
                                cfg.positionToleranceFrac
                            )
                        ) {
                            recordSkip("tolerance");
                            logEvent(
                                ns,
                                ctrl.stock,
                                "debug",
                                "position_within_tolerance",
                                verbosity,
                                {
                                    sym,
                                    dir: "SHORT",
                                    targetShares: want.targetShares,
                                    currentShares: shortShares,
                                    toleranceFrac: cfg.positionToleranceFrac,
                                }
                            );
                            continue;
                        }

                        const priceUsed = snap?.bid ?? 0;
                        const minNotional = cfg.minOrderNotional;
                        const floor = cashFloor(ns, equityForSizing, cfg);
                        const deployableCash = Math.max(
                            0,
                            cashForSizing - floor
                        );
                        const minSharesToClear =
                            priceUsed > 0
                                ? Math.ceil(minNotional / priceUsed)
                                : 0;
                        const sharesComputed = shortMore;
                        const sharesBumpedTo =
                            priceUsed > 0 &&
                            sharesComputed * priceUsed < minNotional
                                ? Math.max(sharesComputed, minSharesToClear)
                                : sharesComputed;

                        const caps: { label: string; shares: number }[] = [];
                        const maxStockCap =
                            snap?.maxShares !== undefined
                                ? Math.max(0, snap.maxShares - shortShares)
                                : Number.POSITIVE_INFINITY;
                        caps.push({ label: "max_shares", shares: maxStockCap });

                        const remainingSymbolValue = Math.max(
                            0,
                            equityForSizing * perSymbolCap -
                                priceUsed * shortShares
                        );
                        caps.push({
                            label: "max_symbol_cap",
                            shares:
                                priceUsed > 0
                                    ? Math.floor(
                                          remainingSymbolValue / priceUsed
                                      )
                                    : 0,
                        });

                        const remainingTotalValue = Math.max(
                            0,
                            equityForSizing * totalCap - grossExposure
                        );
                        caps.push({
                            label: "max_total_cap",
                            shares:
                                priceUsed > 0
                                    ? Math.floor(remainingTotalValue / priceUsed)
                                    : 0,
                        });

                        caps.push({
                            label: "cash_floor",
                            shares:
                                priceUsed > 0
                                    ? Math.floor(deployableCash / priceUsed)
                                    : 0,
                        });

                        let sharesFinal = sharesBumpedTo;
                        let bindingConstraint: string | null = null;
                        for (const cap of caps) {
                            const capShares = Math.max(
                                0,
                                Math.floor(cap.shares)
                            );
                            if (capShares < sharesFinal) {
                                sharesFinal = capShares;
                                bindingConstraint = cap.label;
                            }
                        }
                        const sharesAffordableCap = sharesFinal;
                        const notionalFinal = priceUsed * sharesFinal;

                        const reasons = orderThresholdReasons(
                            sharesFinal,
                            notionalFinal,
                            cfg,
                            "SHORT"
                        );
                        const spreadReason = spreadSignalReason(
                            spreadFrac,
                            want.signalFrac,
                            cfg
                        );
                        if (spreadReason) reasons.push(spreadReason);

                        if (reasons.includes("min_notional") && !bindingConstraint) {
                            bindingConstraint = "min_notional";
                        }

                        if (reasons.length > 0) {
                            reasons.forEach(recordSkip);
                            const logFields: Record<string, unknown> = {
                                sym,
                                price: priceUsed,
                                notional: notionalFinal,
                                minNotional,
                                deployableCash,
                                side: "SHORT",
                                sharesReq: sharesFinal,
                                reasons,
                            };
                            if (reasons.includes("min_notional")) {
                                logFields.priceUsed = priceUsed;
                                logFields.sharesComputed = sharesComputed;
                                logFields.sharesBumpedTo = sharesBumpedTo;
                                logFields.sharesAffordableCap =
                                    sharesAffordableCap;
                                logFields.sharesFinal = sharesFinal;
                                logFields.notionalFinal = notionalFinal;
                                logFields.bindingConstraint =
                                    bindingConstraint ?? "min_notional";
                            }

                            logEvent(
                                ns,
                                ctrl.stock,
                                "debug",
                                "skip_order",
                                verbosity,
                                logFields
                            );
                            continue;
                        }

                        if (sharesFinal <= 0) continue;

                        const frictionFrac = estimateFrictionFracForEntry(
                            ns,
                            snap,
                            sharesFinal,
                            "SHORT",
                            cfg
                        );
                        const expectedEdgeFrac = have4S
                            ? Math.abs((snap?.forecast ?? 0) - 0.5)
                            : Math.abs(want.signalFrac ?? 0);
                        if (
                            expectedEdgeFrac <
                            frictionFrac + cfg.frictionMinEdgeFrac
                        ) {
                            recordSkip("friction_edge");
                            logEvent(
                                ns,
                                ctrl.stock,
                                "debug",
                                "friction_edge_skip",
                                verbosity,
                                {
                                    sym,
                                    edgeFrac: expectedEdgeFrac,
                                    frictionFrac,
                                    minEdgeFrac: cfg.frictionMinEdgeFrac,
                                    notional: priceUsed * sharesFinal,
                                    shares: sharesFinal,
                                }
                            );
                            continue;
                        }

                        const added = addCandidate({
                            sym,
                            side: "SHORT",
                            kind: "ENTER",
                            exec: () => {
                                const posStateExec = ensurePositionState(
                                    ctrl.stock as StockState,
                                    sym
                                );
                                posStateExec.targetShortShares = sharesFinal;
                                posStateExec.entryPrice = snap?.bid ?? undefined;
                                    execOrder(
                                        ns,
                                        ctrl.stock as StockState,
                                        symbols,
                                        "SHORT",
                                        sym,
                                        sharesFinal,
                                        cfg,
                                        orderStats
                                    );
                                },
                            });
                        if (added) {
                            grossExposure += priceUsed * sharesFinal;
                            cashForSizing = ns.getServerMoneyAvailable("home");
                            equityForSizing = estimateEquityQuick(ns, symbols);
                            if (isNew) openCount++;
                        }
                    }
                }
            }

            const sideRank: Record<OrderSide, number> = {
                SELL: 0,
                COVER: 1,
                BUY: 2,
                SHORT: 3,
            };
            candidates.sort((a, b) => {
                if (a.kind !== b.kind) return a.kind === "EXIT" ? -1 : 1;
                const symCmp = a.sym.localeCompare(b.sym);
                if (symCmp !== 0) return symCmp;
                return sideRank[a.side] - sideRank[b.side];
            });

            let actions = 0;
            const executedSymbols = new Set<string>();
            for (const cand of candidates) {
                if (actions >= cfg.maxActionsPerTick) break;
                if (executedSymbols.has(cand.sym)) continue;

                const posState = ensurePositionState(
                    ctrl.stock as StockState,
                    cand.sym
                );
                const gate = canEvaluateSymbol(
                    cand.sym,
                    posState,
                    tick,
                    cfg,
                    evaluatedThisTick
                );
                if (!gate.ok) {
                    recordSkip(gate.reason ?? "decision_interval");
                    logEvent(ns, ctrl.stock, "debug", "decision_skip", verbosity, {
                        sym: cand.sym,
                        reason: gate.reason,
                        tick,
                        lastDecisionTick: posState.lastDecisionTick ?? null,
                        cooldownUntilTick: posState.cooldownUntilTick ?? null,
                        decisionIntervalTicks: cfg.decisionIntervalTicks,
                    });
                    continue;
                }

                cand.exec();
                executedSymbols.add(cand.sym);
                actions++;
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

            const openCounts = openPositionCounts(ns, symbols);

            logEvent(ns, ctrl.stock, "info", "rebalance_summary", verbosity, {
                tick,
                mode: ctrl.stock.lastMode,
                actions,
                plannedSymbols: plannedSymbols.size,
                openSymbols: openCounts.openSymbols,
                openLongs: openCounts.openLongs,
                openShorts: openCounts.openShorts,
                cashStart: cash,
                cashEnd,
                equityStart: equity,
                equityEnd,
                desires: desires.size,
                skipsByReason: skipCounts,
                orders: orderStats.orders,
            });

            executedOrdersThisTick = orderStats.orders;
            ctrl.stock.executedOrdersPrevTick = executedOrdersThisTick;
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
    const rebalanceMs = c.rebalanceMs ?? 6000;

    const cooldownTicksFromMs =
        c.cooldownMs !== undefined &&
        (c.cooldownTicks === undefined || c.cooldownTicks === 0)
            ? Math.max(
                  0,
                  Math.ceil((c.cooldownMs ?? 0) / Math.max(1, rebalanceMs))
              )
            : undefined;
    const cooldownTicks =
        c.cooldownTicks !== undefined
            ? c.cooldownTicks
            : cooldownTicksFromMs ?? 0;

    const minTradeIntervalTicks =
        c.minTradeIntervalTicks ??
        (c.minHoldTicks !== undefined ? c.minHoldTicks : 15);
    const minHoldAfterEntryTicks =
        c.minHoldAfterEntryTicks ??
        (c.minHoldTicks !== undefined ? c.minHoldTicks : 30);

    return {
        // runtime
        rebalanceMs,
        cooldownMs: c.cooldownMs ?? 20000,
        cooldownTicks,
        decisionIntervalTicks: c.decisionIntervalTicks ?? 1,
        minHoldTicks: minTradeIntervalTicks, // deprecated alias
        minHoldAfterEntryTicks,
        minTradeIntervalTicks,
        maxActionsPerTick: c.maxActionsPerTick ?? 6,
        logFile: c.logFile ?? "/logs/stock-manager.txt",
        logVerbosity: c.logVerbosity ?? "normal",

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
        minDeltaShares: c.minDeltaShares ?? 10,
        minOrderNotional: c.minOrderNotional ?? 5_000_000,
        positionToleranceFrac: c.positionToleranceFrac ?? 0.05,

        // cash buffer
        minCashAbs: c.minCashAbs ?? 40_000_000,
        minCashFrac: c.minCashFrac ?? 0.1,

        // risk controls
        maxDrawdownFrac: c.maxDrawdownFrac ?? 0.15, // 15% drawdown kill-switch
        pauseAfterKillMs: c.pauseAfterKillMs ?? 5 * 60 * 1000,
        externalSpendResetFrac: c.externalSpendResetFrac ?? 0.5,
        resetEquityPeakOnBoot: c.resetEquityPeakOnBoot ?? false,

        // trend mode clamps (no 4S)
        trendLongOnly: c.trendLongOnly ?? true,
        trendMaxSymbolFrac: c.trendMaxSymbolFrac ?? 0.02, // 2% per symbol
        trendMaxTotalFrac: c.trendMaxTotalFrac ?? 0.2, // 20% total exposure
        maxSpreadFrac: c.maxSpreadFrac ?? 0.003, // skip if spread > 0.3%
        minPrice: c.minPrice ?? 5_000, // skip cheap noisy tickers
        minSignalFrac: c.minSignalFrac ?? 0.004,
        spreadEdgeBufferFrac: c.spreadEdgeBufferFrac ?? 0.001,

        frictionMinEdgeFrac: c.frictionMinEdgeFrac ?? 0,
        frictionIncludeCommission: c.frictionIncludeCommission ?? true,

        legacyMinHoldTicks:
            c.minHoldTicks !== undefined &&
            c.minHoldAfterEntryTicks === undefined &&
            c.minTradeIntervalTicks === undefined
                ? c.minHoldTicks
                : undefined,
        legacyCooldownMs:
            cooldownTicksFromMs !== undefined ? c.cooldownMs : undefined,
    };
}

function enforceHysteresis(
    ns: NS,
    stockState: StockState,
    cfg: NormalizedConfig
): void {
    const epsilon = 1e-6;

    if (cfg.enterLong <= cfg.exitLong) {
        const enterBefore = cfg.enterLong;
        const exitBefore = cfg.exitLong;
        cfg.exitLong = Math.min(enterBefore, exitBefore);
        cfg.enterLong = Math.min(
            0.999999,
            Math.max(enterBefore, exitBefore) + epsilon
        );
        logEvent(ns, stockState, "warn", "hysteresis_fix", stockState.logVerbosity, {
            mode: "forecast_long",
            enterBefore,
            exitBefore,
            enterAfter: cfg.enterLong,
            exitAfter: cfg.exitLong,
        });
    }

    if (cfg.enterShort >= cfg.exitShort) {
        const enterBefore = cfg.enterShort;
        const exitBefore = cfg.exitShort;
        cfg.enterShort = Math.max(
            0,
            Math.min(enterBefore, exitBefore) - epsilon
        );
        cfg.exitShort = Math.min(
            0.999999,
            Math.max(enterBefore, exitBefore)
        );
        logEvent(ns, stockState, "warn", "hysteresis_fix", stockState.logVerbosity, {
            mode: "forecast_short",
            enterBefore,
            exitBefore,
            enterAfter: cfg.enterShort,
            exitAfter: cfg.exitShort,
        });
    }

    if (cfg.trendEnter <= cfg.trendExit) {
        const enterBefore = cfg.trendEnter;
        const exitBefore = cfg.trendExit;
        cfg.trendExit = Math.min(enterBefore, exitBefore);
        cfg.trendEnter = Math.max(enterBefore, exitBefore) + epsilon;
        logEvent(ns, stockState, "warn", "hysteresis_fix", stockState.logVerbosity, {
            mode: "trend_long",
            enterBefore,
            exitBefore,
            enterAfter: cfg.trendEnter,
            exitAfter: cfg.trendExit,
        });
    }
}

function cashFloor(ns: NS, equity: number, cfg: NormalizedConfig): number {
    // Maintain an operating cash buffer so the controller never bricks the run (critical in BN8).
    return Math.max(cfg.minCashAbs, equity * cfg.minCashFrac);
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
    verbosity: Verbosity | undefined,
    fields: Record<string, unknown> = {}
): void {
    const effectiveVerbosity =
        verbosity ?? (ctrlStock as StockState & { logVerbosity?: Verbosity }).logVerbosity ?? "normal";
    if (!shouldLogEvent(level, event, effectiveVerbosity)) return;
    ctrlStock.logger.log(level, event, { tick: ctrlStock.tick, ...fields });
}

function shouldLogEvent(
    level: LogLevel,
    event: string,
    verbosity: Verbosity
): boolean {
    if (verbosity === "debug") return true;

    const quietAllowed = new Set([
        "order",
        "state_transition",
        "circuit_breaker",
        "risk_kill",
        "paused",
        "boot",
        "order_error",
        "external_spend_reset",
        "equity_peak_reset_boot",
        "config_deprecated",
    ]);

    if (verbosity === "quiet") return quietAllowed.has(event);

    // normal
    const normalAllowed = new Set([
        ...quietAllowed,
        "rebalance_summary",
    ]);
    return normalAllowed.has(event);
}

function posOf(ns: NS, sym: string) {
    const [longShares, longPx, shortShares, shortPx] = ns.stock.getPosition(sym);
    return { longShares, longPx, shortShares, shortPx };
}

function modeFromHoldings(pos: { longShares: number; shortShares: number }): PositionMode {
    if (pos.longShares > 0) return "LONG";
    if (pos.shortShares > 0) return "SHORT";
    return "FLAT";
}

function shortLiquidationValue(shares: number, entryPx: number, coverPx: number): number {
    if (shares <= 0) return 0;
    // Cash already dropped by entryPx * shares when the short was opened.
    // Liquidation equity contribution is locked cash + unrealized PnL.
    return shares * (2 * entryPx - coverPx);
}

function computeLiquidationEquityQuick(
    ns: NS,
    symbols: string[]
): { cash: number; longValue: number; shortValue: number; equity: number } {
    const cash = ns.getServerMoneyAvailable("home");
    let longValue = 0;
    let shortValue = 0;

    for (const sym of symbols) {
        const bid = ns.stock.getBidPrice(sym);
        const ask = ns.stock.getAskPrice(sym);
        const [longShares, , shortShares, shortPx] = ns.stock.getPosition(sym);

        if (longShares > 0) longValue += bid * longShares;
        if (shortShares > 0) shortValue += shortLiquidationValue(shortShares, shortPx, ask);
    }

    return {
        cash,
        longValue,
        shortValue,
        equity: cash + longValue + shortValue,
    };
}

function estimateEquityQuick(ns: NS, symbols: string[]): number {
    return computeLiquidationEquityQuick(ns, symbols).equity;
}

function computeLiquidationEquityFromSnapshot(
    ns: NS,
    snapshot: SymbolSnapshot[]
): { cash: number; longValue: number; shortValue: number; equity: number } {
    const cash = ns.getServerMoneyAvailable("home");
    let longValue = 0;
    let shortValue = 0;

    for (const s of snapshot) {
        if (s.longShares > 0) {
            longValue += s.bid * s.longShares;
        }
        if (s.shortShares > 0) {
            shortValue += shortLiquidationValue(
                s.shortShares,
                s.shortPx,
                s.ask
            );
        }
    }

    return {
        cash,
        longValue,
        shortValue,
        equity: cash + longValue + shortValue,
    };
}

function grossExposureValue(ns: NS, symbols: string[]): number {
    let gross = 0;
    for (const sym of symbols) {
        const [l, , sh] = ns.stock.getPosition(sym);
        gross += ns.stock.getAskPrice(sym) * l;
        gross += ns.stock.getBidPrice(sym) * sh;
    }
    return gross;
}

function estimateFrictionFracForEntry(
    ns: NS,
    snap: SymbolSnapshot | undefined,
    shares: number,
    side: OrderSide,
    cfg: NormalizedConfig
): number {
    if (!snap || shares <= 0) return Number.POSITIVE_INFINITY;
    const price =
        side === "SHORT" ? snap.bid ?? 0 : snap.ask ?? 0;
    const notional = price * shares;
    const spreadCost = Math.abs((snap.ask ?? 0) - (snap.bid ?? 0)) * shares;
    const commission = ns.stock.getConstants().StockMarketCommission;
    const frictionValue =
        spreadCost + (cfg.frictionIncludeCommission ? commission : 0);
    return frictionValue / Math.max(notional, 1);
}

type TickStats = {
    spreadCost: number;
    commission: number;
    realizedPnL: number;
    orders: number;
};

function execOrder(
    ns: NS,
    ctrlStock: StockState,
    symbols: string[],
    side: OrderSide,
    sym: string,
    sharesReq: number,
    cfg: NormalizedConfig,
    stats?: TickStats
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
        logEvent(ns, ctrlStock, "error", "order_error", ctrlStock.logVerbosity, {
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
    const spreadCost = Math.abs(ask - bid) * sharesReq;
    const commission = ns.stock.getConstants().StockMarketCommission;
    const equityDelta = equityAfter - equityBefore;
    if (stats) {
        stats.spreadCost += spreadCost;
        stats.commission += commission;
        stats.realizedPnL += equityDelta;
        stats.orders += 1;
    }

    if (
        side === "SHORT" &&
        sharesReq > 0 &&
        ctrlStock.logVerbosity === "debug"
    ) {
        const midPrice = (bid + ask) / 2;
        const filledShares = Math.max(0, p1.shortShares - p0.shortShares);
        const sharesForCheck = filledShares > 0 ? filledShares : sharesReq;
        const positionNotional = Math.abs(sharesForCheck) * midPrice;
        const threshold = positionNotional * 0.05;
        if (Math.abs(equityDelta) > threshold) {
            logEvent(
                ns,
                ctrlStock,
                "debug",
                "equity_sanity_warn",
                ctrlStock.logVerbosity,
                {
                    sym,
                    side,
                    sharesReq,
                    equityBefore,
                    equityAfter,
                    equityDelta,
                    positionNotional,
                    threshold,
                    bid,
                    ask,
                    shortPxBefore: p0.shortPx,
                    shortPxAfter: p1.shortPx,
                    filledShares,
                }
            );
        }
    }

    if (!ctrlStock.lastTrade) ctrlStock.lastTrade = {};

    updatePositionStateFromHoldings(ctrlStock, sym, p1, ctrlStock.tick);
    const modeBefore = modeFromHoldings(p0);
    const modeAfter = modeFromHoldings(p1);
    if (modeBefore !== modeAfter) {
        logEvent(ns, ctrlStock, "info", "state_transition", ctrlStock.logVerbosity, {
            sym,
            from: modeBefore,
            to: modeAfter,
        });
    }
    if (ret !== null) {
        ctrlStock.lastTrade[sym] = { tick: ctrlStock.tick, side };
        setTickCooldown(ctrlStock, sym, ctrlStock.tick, cfg.cooldownTicks);

        logEvent(ns, ctrlStock, "info", "order", ctrlStock.logVerbosity, {
            sym,
            side,
            sharesReq,
            ret,
            bid,
            ask,
            spreadCost,
            commission,
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
}

function liquidateAll(
    ns: NS,
    ctrlStock: StockState,
    symbols: string[],
    cfg: NormalizedConfig
): number {
    let orders = 0;
    for (const sym of symbols) {
        const [l, , sh] = ns.stock.getPosition(sym);
        if (l > 0) {
            execOrder(
                ns,
                ctrlStock,
                symbols,
                "SELL",
                sym,
                l,
                cfg
            );
            orders++;
        }
        if (sh > 0) {
            execOrder(
                ns,
                ctrlStock,
                symbols,
                "COVER",
                sym,
                sh,
                cfg
            );
            orders++;
        }
    }
    return orders;
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

function estimateEquity(
    ns: NS,
    snapshot: SymbolSnapshot[]
): number {
    return computeLiquidationEquityFromSnapshot(ns, snapshot).equity;
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

        // Spread-aware filter: require signal to exceed spread + buffer
        const spreadFrac =
            s.ask > 0 ? (s.ask - s.bid) / Math.max(1, (s.ask + s.bid) / 2) : 1;
        const spreadReason = spreadSignalReason(spreadFrac, absEdge, cfg);
        if (spreadReason) continue;

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
        if (targetShares <= 0) continue;

        // Score by signal strength per volatility
        const score = absEdge / Math.max(1e-6, s.vol ?? 0.05);

        scored.push({
            sym: s.sym,
            dir,
            score,
            targetShares,
            signalFrac: absEdge,
        });
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

function openPositionCounts(
    ns: NS,
    symbols: string[]
): { openLongs: number; openShorts: number; openSymbols: number } {
    let openLongs = 0;
    let openShorts = 0;
    for (const sym of symbols) {
        const p = ns.stock.getPosition(sym);
        if (p[0] > 0) openLongs++;
        if (p[2] > 0) openShorts++;
    }
    return { openLongs, openShorts, openSymbols: openLongs + openShorts };
}

function canEvaluateSymbol(
    sym: string,
    posState: SymbolPositionState,
    tick: number,
    cfg: NormalizedConfig,
    evaluatedThisTick: Set<string>,
    preview = false
): { ok: boolean; reason?: "decision_interval" | "cooldown_tick" } {
    // If we've already evaluated this symbol in the current logical tick,
    // allow re-evaluation (e.g., exits then entries) without gating.
    if (evaluatedThisTick.has(sym)) {
        return { ok: true };
    }

    if (
        typeof posState.cooldownUntilTick === "number" &&
        tick < posState.cooldownUntilTick
    ) {
        return { ok: false, reason: "cooldown_tick" };
    }

    if (
        typeof posState.lastDecisionTick === "number" &&
        tick - posState.lastDecisionTick < cfg.decisionIntervalTicks
    ) {
        return { ok: false, reason: "decision_interval" };
    }

    if (!preview) {
        posState.lastDecisionTick = tick;
        evaluatedThisTick.add(sym);
    }
    return { ok: true };
}

function setTickCooldown(
    stockState: StockState,
    sym: string,
    tick: number,
    cooldownTicks: number
): void {
    if (cooldownTicks <= 0) return;
    const posState = ensurePositionState(stockState, sym);
    posState.cooldownUntilTick = tick + cooldownTicks;
}

function ensurePositionState(
    stockState: StockState,
    sym: string
): SymbolPositionState {
    if (!stockState.positionsBySymbol) stockState.positionsBySymbol = {};
    if (!stockState.positionsBySymbol[sym]) {
        stockState.positionsBySymbol[sym] = { mode: "FLAT" };
    }
    return stockState.positionsBySymbol[sym];
}

function syncPositionStates(
    stockState: StockState,
    snapshot: SymbolSnapshot[],
    tick: number
): void {
    for (const s of snapshot) {
        const posState = ensurePositionState(stockState, s.sym);
        const hasLong = s.longShares > 0;
        const hasShort = s.shortShares > 0;

        if (hasLong) {
            if (posState.mode !== "LONG") posState.mode = "LONG";
            if (posState.enteredTick === undefined) posState.enteredTick = tick;
            if (
                posState.targetLongShares === undefined ||
                posState.targetLongShares <= 0
            ) {
                posState.targetLongShares = s.longShares;
            }
            posState.targetShortShares = undefined;
        } else if (hasShort) {
            if (posState.mode !== "SHORT") posState.mode = "SHORT";
            if (posState.enteredTick === undefined) posState.enteredTick = tick;
            if (
                posState.targetShortShares === undefined ||
                posState.targetShortShares <= 0
            ) {
                posState.targetShortShares = s.shortShares;
            }
            posState.targetLongShares = undefined;
            posState.entryPrice = undefined;
        } else {
            posState.mode = "FLAT";
            posState.enteredTick = undefined;
            posState.targetLongShares = undefined;
            posState.targetShortShares = undefined;
            posState.entryPrice = undefined;
        }
    }
}

function updatePositionStateFromHoldings(
    stockState: StockState,
    sym: string,
    pos: { longShares: number; shortShares: number },
    tick: number
): void {
    const posState = ensurePositionState(stockState, sym);
    const hasLong = pos.longShares > 0;
    const hasShort = pos.shortShares > 0;

    if (hasLong) {
        posState.mode = "LONG";
        if (posState.enteredTick === undefined) posState.enteredTick = tick;
        if (
            posState.targetLongShares === undefined ||
            posState.targetLongShares <= 0
        ) {
            posState.targetLongShares = pos.longShares;
        }
        posState.targetShortShares = undefined;
    } else if (hasShort) {
        posState.mode = "SHORT";
        if (posState.enteredTick === undefined) posState.enteredTick = tick;
        if (
            posState.targetShortShares === undefined ||
            posState.targetShortShares <= 0
        ) {
            posState.targetShortShares = pos.shortShares;
        }
        posState.targetLongShares = undefined;
        posState.entryPrice = undefined;
    } else {
        posState.mode = "FLAT";
        posState.enteredTick = undefined;
        posState.targetLongShares = undefined;
        posState.targetShortShares = undefined;
        posState.entryPrice = undefined;
    }
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
        positionsBySymbol: stockState.positionsBySymbol ?? {},
        prices,
        entry: stockState.entry ?? {},
        equityPeak: stockState.equityPeak ?? 0,
        pausedUntil: stockState.pausedUntil ?? 0,
        lastTrade: stockState.lastTrade ?? {},
        tick: stockState.tick ?? 0,
        executedOrdersPrevTick: stockState.executedOrdersPrevTick ?? 0,
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
