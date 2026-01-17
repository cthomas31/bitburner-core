import type { NS } from "@ns";
import { describe, expect, it } from "vitest";
import { makeStockManager } from "../src/app/stocks/manager.js";
import type { ControllerState } from "../src/domain/controller/types.js";
import { makeFakeNS } from "./fakes/fake_ns";

function makeCtrl(): ControllerState {
    return {
        lastScanTs: 0,
        lastMode: null,
        lastTarget: null,
        lastTargetScore: 0,
        lastTargetApplied: null,
        syscallPid: 0,
        syscallKey: null,
        lastDarkwebCheckTs: 0,
        lastFactionServersCheckTs: 0,
        lastJoinInvitesTs: 0,
        lastOwnedAugsTs: 0,
        lastInstallTs: 0,
        lastWorkFactionTs: 0,
        lastAugsFromFactionTs: 0,
        lastFactionRepTs: 0,
        lastAugProbeTs: 0,
        lastAugStatsTs: 0,
        lastAugPrereqTs: 0,
        lastAugBuyTs: 0,
        pendingAugsCount: 0,
        chosenFaction: null,
        factionRep: 0,
        invites: [],
        augsFromFaction: [],
        augCandidates: [],
        augFacts: {},
        factionRepCache: {},
        factionAugsCache: {},
        factionCacheIndex: 0,
        lastFactionCacheUpdateTs: 0,
        pendingPurchase: null,
        ensureBackoff: {},
        statusMessages: [],
        ownedSet: new Set<string>(),
    };
}

function readLogs(ns: ReturnType<typeof makeFakeNS>, path: string) {
    const raw = ns.read(path);
    if (!raw.trim()) return [];
    return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("min notional handling", () => {
    it("bumps buy orders to clear the min notional when affordable", async () => {
        const ns = makeFakeNS(undefined, {
            cash: 75_000_000,
            enable4S: true,
            stocks: {
                AAA: {
                    bid: 1000,
                    ask: 1001,
                    forecast: 0.6,
                    vol: 0.05,
                    maxShares: 1_000_000,
                },
            },
        });
        const mgr = makeStockManager({
            rebalanceMs: 0,
            cooldownMs: 0,
            minHoldTicks: 0,
            logFile: "/logs/min-notional-1.jsonl",
            logVerbosity: "debug",
            maxSymbolFrac: 0.5,
            maxTotalFrac: 1,
        });
        const ctrl = makeCtrl();

        await mgr.init(ns as unknown as NS, ctrl);
        await mgr.tick(ns as unknown as NS, ctrl, Date.now());

        const pos = ns.stock.getPosition("AAA");
        const minShares = Math.ceil(5_000_000 / 1001);
        expect(pos[0]).toBeGreaterThanOrEqual(minShares);
        expect(ns.orders.filter((o) => o.side === "BUY").length).toBe(1);
    });

    it("skips with a cash_floor binding constraint when min notional cannot be met", async () => {
        const logFile = "/logs/min-notional-skip.jsonl";
        const ns = makeFakeNS(undefined, {
            cash: 45_000_000,
            enable4S: true,
            stocks: {
                AAA: {
                    bid: 1000,
                    ask: 1001,
                    forecast: 0.6,
                    vol: 0.05,
                    maxShares: 1_000_000,
                },
            },
        });
        const mgr = makeStockManager({
            rebalanceMs: 0,
            cooldownMs: 0,
            minHoldTicks: 0,
            logFile,
            logVerbosity: "debug",
            maxSymbolFrac: 0.5,
            maxTotalFrac: 1,
        });
        const ctrl = makeCtrl();

        await mgr.init(ns as unknown as NS, ctrl);
        await mgr.tick(ns as unknown as NS, ctrl, Date.now());

        const pos = ns.stock.getPosition("AAA");
        expect(pos[0]).toBe(0);
        expect(ns.orders.length).toBe(0);

        const logs = readLogs(ns, logFile);
        const skip = logs.find((l) => l.event === "skip_order");
        expect(skip).toBeDefined();
        const reasons = (skip?.reasons as string[]) ?? [];
        const bindingConstraint = skip?.bindingConstraint as string | undefined;
        const sharesComputed = Number(skip?.sharesComputed ?? 0);
        const sharesFinal = Number(skip?.sharesFinal ?? 0);
        expect(reasons).toContain("min_notional");
        expect(bindingConstraint).toBe("cash_floor");
        expect(sharesComputed).toBeGreaterThan(sharesFinal);
    });
});
