import type { NS } from "@ns";

type ParsedFlags = {
    path: string;
    intervalMs: number;
    only: string;
    noSummary: boolean;
    help: boolean;
    _: (string | number)[];
};

const DEFAULT_PATH = "/logs/stock-manager.txt";
const DEFAULT_INTERVAL = 500;

/** @param ns NS */
export async function main(ns: NS): Promise<void> {
    ns.disableLog("sleep");

    const args = ns.flags([
        ["path", DEFAULT_PATH],
        ["intervalMs", DEFAULT_INTERVAL],
        ["only", ""],
        ["noSummary", false],
        ["help", false],
    ]) as ParsedFlags;

    if (args.help) {
        ns.tprint(
            "Usage: run bin/stock-log-follow.js [--path /logs/stock-manager.txt] [--intervalMs 500] [--only event1,event2] [--noSummary]"
        );
        return;
    }

    const logPath = typeof args.path === "string" ? args.path : DEFAULT_PATH;
    const interval = Math.max(
        50,
        Number.isFinite(args.intervalMs) ? Number(args.intervalMs) : DEFAULT_INTERVAL
    );
    const onlySet = parseOnly(args.only);
    const suppressSummary = Boolean(args.noSummary);

    ns.tprint(
        `[stock-log-follow] watching ${logPath} interval=${interval}ms` +
            (onlySet ? ` only=[${[...onlySet].join(",")}]` : "") +
            (suppressSummary ? " noSummary" : "")
    );

    // Start at current end to avoid re-printing history.
    let printedLines = readLines(ns, logPath).length;

    for (;;) {
        const lines = readLines(ns, logPath);

        // File rotation/shrink detection
        if (lines.length < printedLines) {
            ns.print(
                `[stock-log-follow] noticed file shrink (${printedLines} -> ${lines.length}); resetting cursor.`
            );
            printedLines = 0;
        }

        if (lines.length > printedLines) {
            const fresh = lines.slice(printedLines);
            for (const line of fresh) {
                const out = formatLine(ns, line, { onlySet, suppressSummary });
                if (out) ns.print(out);
            }
            printedLines = lines.length;
        }

        await ns.sleep(interval);
    }
}

function readLines(ns: NS, path: string): string[] {
    try {
        const raw = ns.read(path);
        if (typeof raw !== "string" || raw.length === 0) return [];
        const parts = raw.split(/\r?\n/);
        while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
        return parts;
    } catch (e) {
        ns.print(`[stock-log-follow] read error for ${path}: ${String(e)}`);
        return [];
    }
}

function parseOnly(raw: string): Set<string> | null {
    if (!raw) return null;
    const vals = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return vals.length ? new Set(vals) : null;
}

function formatLine(
    ns: NS,
    line: string,
    opts: { onlySet: Set<string> | null; suppressSummary: boolean }
): string | null {
    if (!line.trim()) return null;

    try {
        const obj = JSON.parse(line);
        if (!obj || typeof obj !== "object") return line;

        const event = (obj as Record<string, unknown>).event;
        if (opts.onlySet && (!event || !opts.onlySet.has(String(event)))) {
            return null;
        }

        switch (event) {
            case "rebalance_summary":
                if (opts.suppressSummary) return null;
                return formatRebalanceSummary(obj as RebalanceSummary);
            case "order":
                return formatOrder(obj as OrderEvent);
            case "state_transition":
                return formatStateTransition(obj as StateTransitionEvent);
            case "risk_kill":
                return formatRiskKill(obj as RiskKillEvent);
            case "paused":
                return formatPaused(obj as PausedEvent);
            case "external_spend_reset":
                return formatExternalSpendReset(obj as ExternalSpendResetEvent);
            default:
                return formatFallback(obj);
        }
    } catch {
        // Not JSON
        return line;
    }
}

type BaseEvent = {
    ts?: string;
    runId?: string;
    level?: string;
    event?: string;
    tick?: number;
};

type RebalanceSummary = BaseEvent & {
    mode?: string;
    actions?: number;
    plannedSymbols?: number;
    openSymbols?: number;
    openLongs?: number;
    openShorts?: number;
    cashStart?: number;
    cashEnd?: number;
    equityStart?: number;
    equityEnd?: number;
    desires?: number;
    skipsByReason?: Record<string, number>;
    orders?: number;
    entriesPaused?: boolean;
};

type OrderEvent = BaseEvent & {
    sym?: string;
    side?: string;
    sharesReq?: number;
    bid?: number;
    ask?: number;
    spreadCost?: number;
    commission?: number;
    cashBefore?: number;
    cashAfter?: number;
    equityBefore?: number;
    equityAfter?: number;
    posBefore?: { longShares?: number; shortShares?: number };
    posAfter?: { longShares?: number; shortShares?: number };
    deltaLong?: number;
    deltaShort?: number;
};

type StateTransitionEvent = BaseEvent & {
    sym?: string;
    from?: string;
    to?: string;
};

type RiskKillEvent = BaseEvent & {
    drawdownFrac?: number;
    cashBefore?: number;
    cashAfter?: number;
    equityBefore?: number;
    equityPeakBefore?: number;
    pausedUntil?: number;
    reason?: string;
};

type PausedEvent = BaseEvent & {
    pausedUntil?: number;
    cash?: number;
    equity?: number;
};

type ExternalSpendResetEvent = BaseEvent & {
    equityPeakBefore?: number;
    equityNow?: number;
    dropFrac?: number;
    threshold?: number;
};

function formatRebalanceSummary(ev: RebalanceSummary): string {
    const open =
        ev.openLongs !== undefined || ev.openShorts !== undefined
            ? `open ${safeNum(ev.openLongs)}/${safeNum(ev.openShorts)}`
            : ev.openSymbols !== undefined
            ? `open ${ev.openSymbols}`
            : "";
    const cash =
        ev.cashStart !== undefined && ev.cashEnd !== undefined
            ? `cash ${fmtMoney(ev.cashStart)}→${fmtMoney(ev.cashEnd)}`
            : "";
    const equity =
        ev.equityStart !== undefined && ev.equityEnd !== undefined
            ? `equity ${fmtMoney(ev.equityStart)}→${fmtMoney(ev.equityEnd)}`
            : "";
    const skips =
        ev.skipsByReason && Object.keys(ev.skipsByReason).length > 0
            ? `skips=${compactObject(ev.skipsByReason)}`
            : "";
    const paused = ev.entriesPaused ? "ENTRIES PAUSED" : "";

    return [
        `[rebalance]`,
        tickPrefix(ev),
        `mode=${ev.mode ?? "?"}`,
        `actions=${safeNum(ev.actions)}`,
        `orders=${safeNum(ev.orders)}`,
        `planned=${safeNum(ev.plannedSymbols)}`,
        open,
        `desires=${safeNum(ev.desires)}`,
        cash,
        equity,
        skips,
        paused,
    ]
        .filter(Boolean)
        .join(" ");
}

function formatOrder(ev: OrderEvent): string {
    const posAfter = ev.posAfter ?? {};
    const posBefore = ev.posBefore ?? {};
    const deltaLong =
        ev.deltaLong !== undefined
            ? ev.deltaLong
            : (posAfter.longShares ?? 0) - (posBefore.longShares ?? 0);
    const deltaShort =
        ev.deltaShort !== undefined
            ? ev.deltaShort
            : (posAfter.shortShares ?? 0) - (posBefore.shortShares ?? 0);

    const equityDelta =
        ev.equityBefore !== undefined && ev.equityAfter !== undefined
            ? ev.equityAfter - ev.equityBefore
            : undefined;

    return [
        `[order]`,
        tickPrefix(ev),
        ev.sym ?? "?",
        ev.side ?? "?",
        `x${safeNum(ev.sharesReq)}`,
        pricePair(ev.bid, ev.ask),
        `spread=${fmtMoney(ev.spreadCost)}`,
        `fee=${fmtMoney(ev.commission)}`,
        `ΔL=${safeNum(deltaLong)}`,
        `ΔS=${safeNum(deltaShort)}`,
        equityDelta !== undefined
            ? `Δeq=${fmtMoney(equityDelta)}`
            : undefined,
        ev.equityBefore !== undefined && ev.equityAfter !== undefined
            ? `eq ${fmtMoney(ev.equityBefore)}→${fmtMoney(ev.equityAfter)}`
            : undefined,
        `pos ${safeNum(posAfter.longShares)}L/${safeNum(posAfter.shortShares)}S`,
    ]
        .filter(Boolean)
        .join(" ");
}

function formatStateTransition(ev: StateTransitionEvent): string {
    return [
        `[state]`,
        tickPrefix(ev),
        ev.sym ?? "?",
        `${ev.from ?? "?"}→${ev.to ?? "?"}`,
    ].join(" ");
}

function formatRiskKill(ev: RiskKillEvent): string {
    return [
        `[risk_kill]`,
        tickPrefix(ev),
        `drawdown=${fmtPct(ev.drawdownFrac)}`,
        `cash ${fmtMoney(ev.cashBefore)}→${fmtMoney(ev.cashAfter)}`,
        `equity ${fmtMoney(ev.equityBefore)} (peak ${fmtMoney(ev.equityPeakBefore)})`,
        `pausedUntil=${fmtTime(ev.pausedUntil)}`,
        ev.reason ? `reason=${ev.reason}` : undefined,
    ]
        .filter(Boolean)
        .join(" ");
}

function formatPaused(ev: PausedEvent): string {
    return [
        `[paused]`,
        tickPrefix(ev),
        `until=${fmtTime(ev.pausedUntil)}`,
        ev.cash !== undefined ? `cash=${fmtMoney(ev.cash)}` : undefined,
        ev.equity !== undefined ? `equity=${fmtMoney(ev.equity)}` : undefined,
    ]
        .filter(Boolean)
        .join(" ");
}

function formatExternalSpendReset(ev: ExternalSpendResetEvent): string {
    return [
        `[external_spend_reset]`,
        tickPrefix(ev),
        `drop=${fmtPct(ev.dropFrac)} (>=${fmtPct(ev.threshold)})`,
        `peak ${fmtMoney(ev.equityPeakBefore)} → baseline ${fmtMoney(ev.equityNow)}`,
    ].join(" ");
}

function formatFallback(obj: unknown): string {
    if (!obj || typeof obj !== "object") return String(obj);
    const shallow = { ...(obj as Record<string, unknown>) };
    // Avoid dumping huge position blobs
    delete shallow["posBefore"];
    delete shallow["posAfter"];
    return `[${(obj as BaseEvent).event ?? "log"}] ${compactObject(shallow)}`;
}

function tickPrefix(ev: BaseEvent): string {
    return ev.tick !== undefined ? `t${ev.tick}` : "";
}

function pricePair(bid?: number, ask?: number): string {
    if (bid === undefined && ask === undefined) return "";
    return `px ${fmtPrice(bid)}/${fmtPrice(ask)}`;
}

function fmtPrice(n: number | undefined): string {
    if (n === undefined || !Number.isFinite(n)) return "-";
    return n >= 1000 ? n.toFixed(2) : n.toPrecision(4);
}

function fmtMoney(n: number | undefined): string {
    if (n === undefined || !Number.isFinite(n)) return "-";
    const abs = Math.abs(n);
    const units = [
        { div: 1e12, suffix: "t" },
        { div: 1e9, suffix: "b" },
        { div: 1e6, suffix: "m" },
        { div: 1e3, suffix: "k" },
    ];
    for (const u of units) {
        if (abs >= u.div) return `${(n / u.div).toFixed(2)}${u.suffix}`;
    }
    return n.toFixed(0);
}

function fmtPct(f: number | undefined): string {
    if (f === undefined || !Number.isFinite(f)) return "-";
    return `${(f * 100).toFixed(2)}%`;
}

function fmtTime(ts: number | undefined): string {
    if (ts === undefined || !Number.isFinite(ts)) return "n/a";
    return new Date(ts).toLocaleTimeString();
}

function compactObject(obj: Record<string, unknown>): string {
    return JSON.stringify(obj);
}

function safeNum(n: number | undefined): string {
    return Number.isFinite(n ?? NaN) ? String(n) : "-";
}
