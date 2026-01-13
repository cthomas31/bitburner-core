/**
 * scripts/gang/manager.ts
 *
 * Early BN2 gang manager:
 *  - Trains members (hacking + combat).
 *  - Uses low-risk crimes when stats are decent.
 *  - Sends some members to Vigilante Justice if wanted is high.
 *  - NEVER enables territory warfare.
 *
 * Usage:
 *   run scripts/gang/manager.js
 *
 * Safe for early BN2: no ascension, no equipment, no warfare.
 */

import type { GangMemberInfo, NS } from "@ns";

// ============== Type Definitions ==============

interface GangConfig {
    loopIntervalMs: number;

    // Training thresholds
    minHackForCrimes: number;
    minCombatForCrimes: number;

    // Wanted management
    minEfficiencyBeforeCleanup: number;
    targetEfficiencyAfterCleanup: number;
    vigilanteFraction: number;

    // Ascension tuning (conservative)
    enableAscension: boolean;
    minAscendHackMult: number;
    minAscendCombatMult: number;
    minRespectBeforeAscend: number;
    gangSafetyRespect: number;
    ascendCooldownMs: number;

    // Crime focus: "money" or "respect"
    crimeFocus: "money" | "respect";
}

interface TaskMap {
    trainHack: string | null;
    trainCombat: string | null;
    vigilante: string | null;
    crimes: string[];
}

interface MemberEntry {
    name: string;
    info: GangMemberInfo;
}

interface ManageGangResult {
    cleanupMode: boolean;
    lastAscendTime: Record<string, number>;
}

// ============== Main Entry Point ==============

export async function main(ns: NS): Promise<void> {
    ns.disableLog("sleep");
    ns.disableLog("gang.setTerritoryWarfare");

    if (!ns.gang || !ns.gang.inGang()) {
        //ns.tprint("[gang-manager] You are not in a gang.");
        return;
    }

    const cfg: GangConfig = {
        loopIntervalMs: 3000,

        // Training thresholds
        minHackForCrimes: 150,
        minCombatForCrimes: 150,

        // Wanted management
        minEfficiencyBeforeCleanup: 0.85,  // if eff < 0.90 (10%+ penalty) -> start cleanup
        targetEfficiencyAfterCleanup: 0.95, // keep cleaning until eff > 0.96 (~4% penalty)
        vigilanteFraction: 1.0,

        // Ascension tuning (conservative)
        enableAscension: true,
        minAscendHackMult: 3.0,      // require at least 3x hack multiplier
        minAscendCombatMult: 1.5,    // and 1.5x on all combat stats
        minRespectBeforeAscend: 1000, // don't ascend total scrubs
        gangSafetyRespect: 2_500_000, // avoid ascensions below this respect level
        ascendCooldownMs: 5 * 60 * 1000, // per-member cooldown between ascensions

        // Crime focus: "money" or "respect"
        crimeFocus: "money",    // change to "respect" when you want rep-focused crimes
    };

    const taskMap = detectTasks(ns);
    if (!taskMap.trainHack || !taskMap.trainCombat || !taskMap.vigilante || taskMap.crimes.length === 0) {
        ns.tprint("[gang-manager] Could not auto-detect all required tasks.");
        ns.tprint("[gang-manager] Detected: " + JSON.stringify(taskMap, null, 2));
        return;
    }

    ns.tprint("[gang-manager] Detected tasks:");
    ns.tprint("  Train Hacking : " + taskMap.trainHack);
    ns.tprint("  Train Combat  : " + taskMap.trainCombat);
    ns.tprint("  Vigilante     : " + taskMap.vigilante);
    ns.tprint("  Crime tasks   : " + taskMap.crimes.join(", "));

    // Persistent wanted cleanup mode flag
    let cleanupMode = false;

    // Keep track of last ascension times to avoid thrashing
    let lastAscendTime: Record<string, number> = {};

    for (; ;) {
        try {
            const res: ManageGangResult = await manageGang(ns, cfg, taskMap, cleanupMode, lastAscendTime);
            cleanupMode = res.cleanupMode;
            lastAscendTime = res.lastAscendTime;
        } catch (e) {
            ns.print("[gang-manager] ERROR: " + String(e));
        }
        await ns.sleep(cfg.loopIntervalMs);
    }
}

// ============== Task Detection ==============

/**
 * Detect task names from ns.gang.getTaskNames().
 * Tries to find:
 *  - training tasks (hacking & combat)
 *  - vigilante task
 *  - all crime tasks (everything else that's not training/vigilante/territory)
 */
function detectTasks(ns: NS): TaskMap {
    const tasks = ns.gang.getTaskNames();
    const lower = (s: string): string => s.toLowerCase();

    let trainHack: string | null = null;
    let trainCombat: string | null = null;
    let vigilante: string | null = null;
    const crimes: string[] = [];

    for (const t of tasks) {
        const lt = lower(t);

        if (lt.includes("train") && lt.includes("hack")) {
            trainHack = t;
            continue;
        }
        if (lt.includes("train") && lt.includes("combat")) {
            trainCombat = t;
            continue;
        }
        if (lt.includes("vigilante")) {
            vigilante = t;
            continue;
        }
        if (lt.includes("territory")) {
            // ignore territory tasks entirely
            continue;
        }
        // Not training/vigilante/territory → treat as crime
        crimes.push(t);
    }

    // Sort crimes alphabetically for deterministic behavior
    crimes.sort();

    return {
        trainHack,
        trainCombat,
        vigilante,
        crimes
    };
}

// ============== Main Loop Logic ==============

/**
 * Main per-loop logic.
 */
async function manageGang(
    ns: NS,
    cfg: GangConfig,
    taskMap: TaskMap,
    cleanupModePrev: boolean,
    lastAscendTimePrev: Record<string, number>
): Promise<ManageGangResult> {
    const gangAPI = ns.gang;

    // ALWAYS keep territory warfare off early game.
    try {
        gangAPI.setTerritoryWarfare(false);
    } catch (e) {
        ns.print("[gang-manager] Warning: setTerritoryWarfare failed: " + e);
    }

    const info = gangAPI.getGangInformation();
    const members = gangAPI.getMemberNames();

    ns.print(
        `[gang-manager] moneyGain=${ns.formatNumber(info.moneyGainRate)}/s ` +
        `respect=${info.respect.toFixed(0)} wanted=${info.wantedLevel.toFixed(0)} ` +
        `penalty=${(info.wantedPenalty * 100).toFixed(1)}%`
    );

    if (members.length === 0) return { cleanupMode: cleanupModePrev, lastAscendTime: lastAscendTimePrev };

    // Hysteresis based on wantedPenalty (efficiency)
    let cleanupMode = cleanupModePrev;
    const lastAscendTime = { ...lastAscendTimePrev };

    // 0..1, where 1 = no penalty, lower = worse
    const eff = info.wantedPenalty;
    const penaltyPct = (1 - eff) * 100;

    ns.print(
        `[gang-manager] efficiency=${(eff * 100).toFixed(1)}% ` +
        `penalty=${penaltyPct.toFixed(1)}%`
    );

    // Turn cleanup ON when efficiency drops below threshold
    if (!cleanupMode && eff < cfg.minEfficiencyBeforeCleanup) {
        cleanupMode = true;
        ns.print("[gang-manager] Efficiency low; entering cleanup mode.");
    }
    // Turn cleanup OFF when efficiency recovers above target
    else if (cleanupMode && eff > cfg.targetEfficiencyAfterCleanup) {
        cleanupMode = false;
        ns.print("[gang-manager] Efficiency recovered; exiting cleanup mode.");
    }

    // If we're in cleanup mode, assign some members to Vigilante
    const numVigiDesired = cleanupMode
        ? Math.max(1, Math.floor(members.length * cfg.vigilanteFraction))
        : 0;

    // Sort members by "expendability" for vigilante: lowest respect first
    const memberInfos: MemberEntry[] = members.map(name => ({
        name,
        info: gangAPI.getMemberInformation(name)
    }));

    memberInfos.sort((a, b) => a.info.earnedRespect - b.info.earnedRespect);

    // Try ascensions first (if enabled), before assigning tasks
    if (cfg.enableAscension) {
        // Start with current gang respect and track what would remain
        let remainingRespect = info.respect;

        for (const { name, info: mi } of memberInfos) {
            const now = Date.now();
            const lastTime = lastAscendTime[name] ?? 0;

            // Only enforce cooldown if we've ascended this member at least once
            if (lastTime !== 0 && now - lastTime < cfg.ascendCooldownMs) continue;

            // If we've already dropped near/at the safety floor, stop ascending this pass
            if (remainingRespect < cfg.gangSafetyRespect) break;

            // Only ascend members who have personally earned enough respect
            if (mi.earnedRespect < cfg.minRespectBeforeAscend) continue;

            // Predict respect loss for this member (matches UI: "gang will lose ... respect")
            const predictedLoss = mi.earnedRespect;
            const predictedAfter = remainingRespect - predictedLoss;

            // Don't ascend if this would push us below safety floor
            if (predictedAfter < cfg.gangSafetyRespect) {
                ns.print(`[gang-manager] Skipping ascend for ${name}: would drop respect below safety floor.`);
                continue;
            }

            const ascRes = ns.gang.getAscensionResult(name);
            if (!ascRes) continue;

            const hackMult = ascRes.hack ?? 1;
            const combatMults = [
                ascRes.str ?? 1,
                ascRes.def ?? 1,
                ascRes.dex ?? 1,
                ascRes.agi ?? 1
            ];
            const minCombatMult = Math.min(...combatMults);

            if (
                hackMult >= cfg.minAscendHackMult &&
                minCombatMult >= cfg.minAscendCombatMult
            ) {
                const ok = ns.gang.ascendMember(name);
                if (ok) {
                    lastAscendTime[name] = now;
                    remainingRespect = predictedAfter; // update our internal view
                    ns.print(
                        `[gang-manager] ASCEND ${name}: ` +
                        `hack x${hackMult.toFixed(2)}, ` +
                        `combat min x${minCombatMult.toFixed(2)}, ` +
                        `respect -> ${ns.formatNumber(remainingRespect)}`
                    );
                }
            }
        }
    }

    const vigilanteSet = new Set<string>();
    for (let i = 0; i < numVigiDesired && i < memberInfos.length; i++) {
        vigilanteSet.add(memberInfos[i].name);
    }

    for (const { name, info: mi } of memberInfos) {
        const currentTask = mi.task;
        let desiredTask: string | null = null;

        if (vigilanteSet.has(name)) {
            desiredTask = taskMap.vigilante;
        } else {
            const combatPower = mi.str + mi.def + mi.dex + mi.agi;
            const hackSkill = mi.hack;

            if (hackSkill < cfg.minHackForCrimes) {
                desiredTask = taskMap.trainHack;
            } else if (combatPower < cfg.minCombatForCrimes) {
                desiredTask = taskMap.trainCombat;
            } else {
                desiredTask = chooseCrimeTask(ns, taskMap.crimes, mi, cfg.crimeFocus);
            }
        }

        if (desiredTask && currentTask !== desiredTask) {
            ns.gang.setMemberTask(name, desiredTask);
            ns.print(`[gang-manager] ${name}: ${currentTask} -> ${desiredTask}`);
        }
    }

    return { cleanupMode, lastAscendTime };
}

// ============== Crime Task Selection ==============

/**
 * Pick the best crime task for a member based on their stats and task stats.
 *
 * focus: "money" or "respect"
 *
 * Heuristic:
 *   - Use ns.gang.getTaskStats() for each crime.
 *   - If task.isHacking → use hack stat.
 *   - Else → use average of combat stats.
 *   - For money focus:
 *       effectiveBase = baseMoney
 *   - For respect focus:
 *       effectiveBase = baseRespect
 *   - Score = effectiveBase * successFactor / max(difficulty, 1)
 */
function chooseCrimeTask(
    ns: NS,
    crimeTasks: string[],
    memberInfo: GangMemberInfo,
    focus: "money" | "respect" = "money"
): string | null {
    if (!crimeTasks || crimeTasks.length === 0) return null;

    const g = ns.gang;

    let bestTask: string | null = null;
    let bestScore = -Infinity;

    const hackStat = memberInfo.hack;
    const combatAvg = (memberInfo.str + memberInfo.def + memberInfo.dex + memberInfo.agi) / 4;

    // Tunable constant: how much "harder" difficulty should feel vs stats.
    const DIFF_FACTOR = 3;

    for (const task of crimeTasks) {
        const stats = g.getTaskStats(task);
        if (!stats) continue;

        const difficulty = Math.max(1, stats.difficulty || 1);
        const baseMoney = stats.baseMoney || 0;
        const baseRespect = stats.baseRespect || 0;

        // Skip tasks that don't generate what we care about
        if (focus === "money" && baseMoney <= 0) continue;
        if (focus === "respect" && baseRespect <= 0) continue;

        // Decide which stat to use
        const isHackingCrime = !!stats.isHacking;
        const power = isHackingCrime ? hackStat : combatAvg;

        // Rough success estimate; higher power vs difficulty = closer to 1
        const successFactor = power / (power + difficulty * DIFF_FACTOR);

        // Choose which "base" to optimize
        const effectiveBase = focus === "respect" ? baseRespect : baseMoney;

        // Very rough expected value: (money or respect) * chance / difficulty
        const score = effectiveBase * successFactor / difficulty;

        // Optional: avoid absurdly hard tasks for very weak members
        if (power < difficulty * 0.5 && stats.baseRespect > 0) {
            // This member is comically underpowered; deprioritize
            continue;
        }

        if (score > bestScore) {
            bestScore = score;
            bestTask = task;
        }
    }

    // Fallback to first crime if all scoring skipped
    if (!bestTask) {
        bestTask = crimeTasks[0];
    }

    return bestTask;
}
