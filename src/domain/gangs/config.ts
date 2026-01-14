import type { NS } from "@ns";
import { getBool, getNumber, getString } from "/lib/settings.js";

export interface GangConfig {
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

export function getGangConfig(ns: NS): GangConfig {
    return {
        loopIntervalMs: getNumber(ns, "gang.loopIntervalMs"),

        minHackForCrimes: getNumber(ns, "gang.training.minHackForCrimes"),
        minCombatForCrimes: getNumber(ns, "gang.training.minCombatForCrimes"),

        minEfficiencyBeforeCleanup: getNumber(ns, "gang.wanted.minEfficiencyBeforeCleanup"),
        targetEfficiencyAfterCleanup: getNumber(ns, "gang.wanted.targetEfficiencyAfterCleanup"),
        vigilanteFraction: getNumber(ns, "gang.wanted.vigilanteFraction"),

        enableAscension: getBool(ns, "gang.ascension.enableAscension"),
        minAscendHackMult: getNumber(ns, "gang.ascension.minAscendHackMult"),
        minAscendCombatMult: getNumber(ns, "gang.ascension.minAscendCombatMult"),
        minRespectBeforeAscend: getNumber(ns, "gang.ascension.minRespectBeforeAscend"),
        gangSafetyRespect: getNumber(ns, "gang.ascension.gangSafetyRespect"),
        ascendCooldownMs: getNumber(ns, "gang.ascension.ascendCooldownMs"),

        crimeFocus: getString(ns, "gang.crimeFocus") as "money" | "respect",
    };
}