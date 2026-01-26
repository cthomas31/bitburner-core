// lib/targets.ts
// Helpers for working with targets.json and choosing best targets.

import type { NS, Player, Server } from "@ns";
import { readJSON } from "/lib/ns/io.js";
import { getTargetConfig } from "/domain/targets/config.js";

// ============== Type Definitions ==============

export interface TargetEntry {
    host?: string;
    hostname?: string;
    requiredHackingSkill?: number;
    scoreMoney?: number;
    scoreXp?: number;
    [key: string]: unknown;
}

export interface XpTarget {
    hostname: string;
    score: number;
    hackTime: number;
    expPerHack: number;
}

// ============== Functions ==============

export async function loadTargets(ns: NS): Promise<TargetEntry[]> {
    const targetsFile = getTargetConfig(ns).targetsFile;
    const targets = (await readJSON(ns, targetsFile)) as TargetEntry[] | null;
    return Array.isArray(targets) ? targets : [];
}

/**
 * Return the top N XP targets, preferring targets.json scores when available
 * and falling back to live Formulas scoring.
 */
export async function getBestXpTargets(ns: NS, count = 1): Promise<XpTarget[]> {
    const fallback: XpTarget = { hostname: "n00dles", score: 0, hackTime: 0, expPerHack: 0 };
    const level = ns.getHackingLevel();
    const byHost = new Map<string, XpTarget>();

    const push = (entry: XpTarget) => {
        if (!entry.hostname) return;
        const prev = byHost.get(entry.hostname);
        if (!prev || entry.score > prev.score) byHost.set(entry.hostname, entry);
    };

    // Prefer precomputed target scores when present
    const targets = await loadTargets(ns);
    for (const t of targets) {
        const hostname = t.hostname ?? t.host ?? "";
        if (!hostname) continue;
        if ((t.requiredHackingSkill ?? 0) > level) continue;
        if (!ns.hasRootAccess(hostname)) continue;

        const score = t.scoreXp ?? 0;
        if (!Number.isFinite(score) || score <= 0) continue;

        push({
            hostname,
            score,
            hackTime: ns.getHackTime(hostname),
            expPerHack: 0,
        });
    }

    // Supplement/fallback with live scoring
    for (const entry of scoreXpAcrossNetwork(ns)) push(entry);

    const ranked = Array.from(byHost.values()).filter((t) => t.score > 0);
    ranked.sort((a, b) => b.score - a.score);
    if (!ranked.length) return [fallback];

    const limit = Math.max(1, Math.floor(count));
    return ranked.slice(0, limit);
}

/**
 * Return the best target matching current hacking level.
 * mode: "money" (default) or "xp".
 */
export async function getBestTarget(
    ns: NS,
    mode: "money" | "xp" = "money"
): Promise<TargetEntry | null> {
    const level = ns.getHackingLevel();
    ns.tprint(`Player hacking level: ${level}`);
    const targets = await loadTargets(ns);
    ns.tprint(`Evaluating ${targets.length} targets for best ${mode} target at hacking level ${level}`);

    // targets: { hostname, scoreMoney, scoreXp, ... }
    const sorted = [...targets].filter(t => (t.requiredHackingSkill ?? 0) <= level);

    if (mode === "xp") {
        sorted.sort((a, b) => (b.scoreXp ?? 0) - (a.scoreXp ?? 0));
    } else {
        sorted.sort((a, b) => (b.scoreMoney ?? 0) - (a.scoreMoney ?? 0));
    }

    const best = sorted[0] || null;
    if (best) {
        ns.tprint(`Best target selected: ${best?.host || "none"} ` +
            `| moneyScore=${best?.scoreMoney?.toFixed(2) || "N/A"} ` +
            `| xpScore=${best?.scoreXp?.toFixed(2) || "N/A"}`);
    }
    return best;
}

/**
 * Choose the best XP target using Formulas.
 *
 * Heuristic:
 *   score = hackExp(server, player) / hackTime(server, player in seconds)
 *
 * We treat the server as "prepped" (minDifficulty, moneyMax) for scoring.
 * If Formulas.exe isn't available, we fall back to "n00dles".
 *
 * Returns an object: { hostname, score, hackTime, expPerHack }
 */
export function getBestXpTarget(ns: NS): XpTarget {
    const ranked = scoreXpAcrossNetwork(ns);
    if (!ranked.length) {
        ns.print("[getBestXpTarget] No XP targets found, using fallback n00dles.");
        return { hostname: "n00dles", score: 0, hackTime: 0, expPerHack: 0 };
    }

    const best = ranked[0];
    ns.print(`[getBestXpTarget] Best XP target: ${best.hostname} | xp/s=${best.score.toFixed(2)} | t=${ns.tFormat(best.hackTime)}`);
    return best;
}

export function computeXpScore(ns: NS, server: Server, player: Player): number {
    const haveFormulas = ns.formulas && ns.formulas.hacking;
    if (!haveFormulas) {
        // Fallback heuristic: XP score proportional to required hacking level
        return 1 / ns.getHackTime(server.hostname);
    }

    const xp = ns.formulas.hacking.hackExp(server, player);
    const time = ns.formulas.hacking.hackTime(server, player);
    return xp / (time / 1000);
}

/**
 * Score all rooted servers for XP/sec (prepped assumption when Formulas present).
 */
function scoreXpAcrossNetwork(ns: NS): XpTarget[] {
    const haveFormulas = Boolean(ns.formulas?.hacking);
    const fh = ns.formulas?.hacking;
    const player: Player = ns.getPlayer();
    const seen = new Set<string>();
    const stack: string[] = ["home"];
    const scored: XpTarget[] = [];

    let h: string | undefined;
    while ((h = stack.pop()) !== undefined) {
        if (seen.has(h)) continue;
        seen.add(h);
        for (const n of ns.scan(h)) stack.push(n);
    }

    for (const host of seen) {
        const s: Server = ns.getServer(host);
        if (!s.hasAdminRights) continue;
        if ((s.requiredHackingSkill ?? 0) > player.skills.hacking) continue;
        if (!s.moneyMax || s.moneyMax <= 0) continue;

        const sim: Server = Object.assign({}, s, {
            hackDifficulty: s.minDifficulty,
            moneyAvailable: s.moneyMax
        });

        const timeMs = haveFormulas && fh ? fh.hackTime(sim, player) : ns.getHackTime(host);
        if (!Number.isFinite(timeMs) || timeMs <= 0) continue;

        const exp =
            haveFormulas && fh && typeof fh.hackExp === "function"
                ? fh.hackExp(sim, player)
                : sim.minDifficulty ?? 1;

        const xpPerSec = exp / (timeMs / 1000);
        if (!isFinite(xpPerSec) || xpPerSec <= 0) continue;

        scored.push({
            hostname: host,
            score: xpPerSec,
            hackTime: timeMs,
            expPerHack: exp,
        });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored;
}
