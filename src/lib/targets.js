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

    return sorted[0] || null;
}
