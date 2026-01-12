// lib/targets.ts
// Helpers for working with targets.json and choosing best targets.

import type { NS, Player, Server } from "@ns";
import { readJSON } from "/lib/ns-io.js";
import { TARGETS_FILE } from "./constants.js";

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
    const targets = await readJSON(ns, TARGETS_FILE) as TargetEntry[] | null;
    return Array.isArray(targets) ? targets : [];
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
    const fallback: XpTarget = { hostname: "n00dles", score: 0, hackTime: 0, expPerHack: 0 };

    if (!ns.formulas || !ns.formulas.hacking) {
        ns.print("[getBestXpTarget] Formulas.exe not available, using fallback n00dles.");
        return fallback;
    }

    const fh = ns.formulas.hacking;
    const player: Player = ns.getPlayer();

    // Simple network scan; if you already have a discovery helper, feel free to reuse it.
    const seen = new Set<string>();
    const stack: string[] = ["home"];
    let h: string | undefined;
    while ((h = stack.pop()) !== undefined) {
        if (seen.has(h)) continue;
        seen.add(h);
        for (const n of ns.scan(h)) stack.push(n);
    }

    let best: XpTarget = fallback;

    for (const host of seen) {
        const s: Server = ns.getServer(host);
        if (!s.hasAdminRights) continue;
        if ((s.requiredHackingSkill ?? 0) > player.skills.hacking) continue;
        if (!s.moneyMax || s.moneyMax <= 0) continue;

        // Pretend it's prepped: min security, full money
        const sim: Server = Object.assign({}, s, {
            hackDifficulty: s.minDifficulty,
            moneyAvailable: s.moneyMax
        });

        const timeMs = fh.hackTime(sim, player);
        if (timeMs <= 0) continue;

        let exp: number;
        if (typeof fh.hackExp === "function") {
            exp = fh.hackExp(sim, player);
        } else {
            // Rough fallback: more difficulty ⇒ more XP
            exp = sim.minDifficulty ?? 1;
        }

        const xpPerSec = exp / (timeMs / 1000);
        if (!isFinite(xpPerSec) || xpPerSec <= 0) continue;

        if (xpPerSec > best.score) {
            best = {
                hostname: host,
                score: xpPerSec,
                hackTime: timeMs,
                expPerHack: exp
            };
        }
    }

    ns.print(`[getBestXpTarget] Best XP target: ${best.hostname} | ` +
        `xp/s=${best.score.toFixed(2)} | t=${ns.tFormat(best.hackTime)}`);
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
