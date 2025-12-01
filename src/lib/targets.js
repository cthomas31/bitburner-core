// lib/targets.js
// Helpers for working with targets.json and choosing best targets.

import { readJSON } from "/lib/ns-io.js";
import { TARGETS_FILE } from "./constants.js";

/** @param {NS} ns */
export async function loadTargets(ns) {
    const targets = await readJSON(ns, TARGETS_FILE, []);
    return Array.isArray(targets) ? targets : [];
}

/**
 * Return the best target matching current hacking level.
 * mode: "money" (default) or "xp".
 *
 * @param {NS} ns
 * @param {"money"|"xp"} mode
 */
export async function getBestTarget(ns, mode = "money") {
    const level = ns.getHackingLevel();
    ns.tprint(`Player hacking level: ${level}`);
    const targets = await loadTargets(ns);
    ns.tprint(`Evaluating ${targets.length} targets for best ${mode} target at hacking level ${level}`);

    // targets: { hostname, scoreMoney, scoreXp, ... }
    const sorted = [...targets].filter(t => t.reqHack <= level);

    if (mode === "xp") {
        sorted.sort((a, b) => b.scoreXp - a.scoreXp);
    } else {
        sorted.sort((a, b) => b.scoreMoney - a.scoreMoney);
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
 *
 * @param {NS} ns
 */
export function getBestXpTarget(ns) {
  const fallback = { hostname: "n00dles", score: 0, hackTime: 0, expPerHack: 0 };

  if (!ns.formulas || !ns.formulas.hacking) {
    ns.print("[getBestXpTarget] Formulas.exe not available, using fallback n00dles.");
    return fallback;
  }

  const fh = ns.formulas.hacking;
  const player = ns.getPlayer();

  // Simple network scan; if you already have a discovery helper, feel free to reuse it.
  const seen = new Set();
  const stack = ["home"];
  while (stack.length) {
    const h = stack.pop();
    if (seen.has(h)) continue;
    seen.add(h);
    for (const n of ns.scan(h)) stack.push(n);
  }

  let best = fallback;

  for (const host of seen) {
    const s = ns.getServer(host);
    if (!s.hasAdminRights) continue;
    if (s.requiredHackingSkill > player.hacking) continue;
    if (!s.moneyMax || s.moneyMax <= 0) continue;

    // Pretend it's prepped: min security, full money
    const sim = Object.assign({}, s, {
      hackDifficulty: s.minDifficulty,
      moneyAvailable: s.moneyMax
    });

    const timeMs = fh.hackTime(sim, player);
    if (timeMs <= 0) continue;

    let exp;
    if (typeof fh.hackExp === "function") {
      exp = fh.hackExp(sim, player);
    } else {
      // Rough fallback: more difficulty ⇒ more XP
      exp = sim.minDifficulty || 1;
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
