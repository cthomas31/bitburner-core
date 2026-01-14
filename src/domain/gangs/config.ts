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
        loopIntervalMs: getNumber(ns, "gangs.loopIntervalMs"),

        minHackForCrimes: getNumber(ns, "gangs.training.minHackForCrimes"),
        minCombatForCrimes: getNumber(ns, "gangs.training.minCombatForCrimes"),

        minEfficiencyBeforeCleanup: getNumber(ns, "gangs.wanted.minEfficiencyBeforeCleanup"),
        targetEfficiencyAfterCleanup: getNumber(ns, "gangs.wanted.targetEfficiencyAfterCleanup"),
        vigilanteFraction: getNumber(ns, "gangs.wanted.vigilanteFraction"),

        enableAscension: getBool(ns, "gangs.ascension.enableAscension"),
        minAscendHackMult: getNumber(ns, "gangs.ascension.minAscendHackMult"),
        minAscendCombatMult: getNumber(ns, "gangs.ascension.minAscendCombatMult"),
        minRespectBeforeAscend: getNumber(ns, "gangs.ascension.minRespectBeforeAscend"),
        gangSafetyRespect: getNumber(ns, "gangs.ascension.gangSafetyRespect"),
        ascendCooldownMs: getNumber(ns, "gangs.ascension.ascendCooldownMs"),
        crimeFocus: getString(ns, "gangs.crimeFocus") as "money" | "respect",
    };
}