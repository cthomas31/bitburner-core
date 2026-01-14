import type { NS } from "@ns";
import { getBool, getNumber, getString } from "/lib/settings.js";

export interface HackConfig {
    moneyThreshold: number;
    securityMargin: number;
    hackMargin: number;
    homeReservedRam: number;
}

export interface BatcherOffsets {
    hack: number;
    weaken1: number;
    grow: number;
    weaken2: number;
}

export interface BatcherPrepConfig {
    moneyFracMin: number;
    secAboveMin: number;
}

export interface BatcherScripts {
    hack: string;
    grow: string;
    weaken: string;
    timedRunner: string;
}

export interface BatcherConfig {
    tickMs: number;
    batchSpacingMs: number;
    maxBatchesPerTarget: number;
    startBufferMs: number;
    ramStarvationCooldownMs: number;
    useHomeAsWorker: boolean;
    reserveHomeRamGb: number;
    homeScheduleBufferGb: number;
    targetRefreshMs: number;
    candidateLimit: number;
    maxTargets: number;
    minTargets: number;
    minTargetRamShareGb: number;
    targetHysteresisKeep: number;
    offsets: BatcherOffsets;
    prep: BatcherPrepConfig;
    statusEveryMs: number;
    actionScripts: BatcherScripts;
    hackFractionPerBatch: number;
}

export function getHackConfig(ns: NS): HackConfig {
    return {
        moneyThreshold: getNumber(ns, "hacking.moneyThreshold"),
        securityMargin: getNumber(ns, "hacking.securityMargin"),
        hackMargin: getNumber(ns, "hacking.hackMargin"),
        homeReservedRam: getNumber(ns, "hacking.homeReservedRam"),
    };
}

export function getBatcherConfig(ns: NS): BatcherConfig {
    return {
        tickMs: getNumber(ns, "batcher.tickMs"),
        batchSpacingMs: getNumber(ns, "batcher.batchSpacingMs"),
        maxBatchesPerTarget: getNumber(ns, "batcher.maxBatchesPerTarget"),
        startBufferMs: getNumber(ns, "batcher.startBufferMs"),
        ramStarvationCooldownMs: getNumber(
            ns,
            "batcher.ramStarvationCooldownMs"
        ),
        useHomeAsWorker: getBool(ns, "batcher.useHomeAsWorker"),
        reserveHomeRamGb: getNumber(ns, "batcher.reserveHomeRamGb"),
        homeScheduleBufferGb: getNumber(ns, "batcher.homeScheduleBufferGb"),
        targetRefreshMs: getNumber(ns, "batcher.targetRefreshMs"),
        candidateLimit: getNumber(ns, "batcher.candidateLimit"),
        maxTargets: getNumber(ns, "batcher.maxTargets"),
        minTargets: getNumber(ns, "batcher.minTargets"),
        minTargetRamShareGb: getNumber(ns, "batcher.minTargetRamShareGb"),
        targetHysteresisKeep: getNumber(ns, "batcher.targetHysteresisKeep"),
        offsets: {
            hack: getNumber(ns, "batcher.offsets.hack"),
            weaken1: getNumber(ns, "batcher.offsets.weaken1"),
            grow: getNumber(ns, "batcher.offsets.grow"),
            weaken2: getNumber(ns, "batcher.offsets.weaken2"),
        },
        prep: {
            moneyFracMin: getNumber(ns, "batcher.prep.moneyFracMin"),
            secAboveMin: getNumber(ns, "batcher.prep.secAboveMin"),
        },
        statusEveryMs: getNumber(ns, "batcher.statusEveryMs"),
        actionScripts: {
            hack: getString(ns, "batcher.scripts.hack"),
            grow: getString(ns, "batcher.scripts.grow"),
            weaken: getString(ns, "batcher.scripts.weaken"),
            timedRunner: getString(ns, "batcher.scripts.timedRunner"),
        },
        hackFractionPerBatch: getNumber(ns, "batcher.hackFractionPerBatch"),
    };
}
