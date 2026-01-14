import {
    Desire,
    NormalizedConfig,
    ScoredCandidate,
    SymbolSnapshot,
    TrendDebug,
} from "/domain/stocks/types.js";

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

        scored.push({ sym: s.sym, dir, score: confidence, targetShares });
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
        if (usedFrac + frac > totalCap) continue;

        desires.set(c.sym, {
            dir: c.dir,
            targetShares: c.targetShares,
            score: c.score,
        });

        open++;
        usedFrac += frac;
    }

    return desires;
}

export function drawdownFrac(equityPeak: number, equityNow: number): number {
    if (equityPeak <= 0) return 0;
    return Math.max(0, 1 - equityNow / equityPeak);
}

export function shouldKillOnDrawdown(
    equityPeak: number,
    equityNow: number,
    maxDrawdownFrac: number
): boolean {
    if (equityPeak <= 0) return false;
    const dd = drawdownFrac(equityPeak, equityNow);
    return dd >= maxDrawdownFrac;
}

export function ema(arr: number[], period: number): number {
    const k = 2 / (period + 1);
    let v = arr[0];
    for (let i = 1; i < arr.length; i++) v = arr[i] * k + v * (1 - k);
    return v;
}

function clamp(x: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, x));
}
