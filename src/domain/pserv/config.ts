import type { NS } from "@ns";
import { getBool, getNumber, getString } from "/lib/settings.js";

export interface PservConfig {
    enabled: boolean;
    hostnamePrefix: string;
    maxServers: number;
    baseRam: number;
    maxTargetRam: number;
    maxSpendFraction: number;
    minCashReserve: number;
    roiMaxPaybackSeconds: number;
    roiMinDeltaThreads: number;
    roiFudgeFactor: number;
}

export function getPservConfig(ns: NS): PservConfig {
    return {
        enabled: getBool(ns, "pserv.enabled"),
        hostnamePrefix: getString(ns, "pserv.hostnamePrefix"),
        maxServers: getNumber(ns, "pserv.maxServers"),
        baseRam: getNumber(ns, "pserv.baseRam"),
        maxTargetRam: getNumber(ns, "pserv.maxTargetRam"),
        maxSpendFraction: getNumber(ns, "pserv.maxSpendFraction"),
        minCashReserve: getNumber(ns, "pserv.minCashReserve"),
        roiMaxPaybackSeconds: getNumber(ns, "pserv.roi.maxPaybackSeconds"),
        roiMinDeltaThreads: getNumber(ns, "pserv.roi.minDeltaThreads"),
        roiFudgeFactor: getNumber(ns, "pserv.roi.fudgeFactor"),
    };
}
