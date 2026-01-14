import type { NS } from "@ns";
import { getNumber } from "/lib/settings.js";

export interface HacknetConfig {
    maxSpendFraction: number;
    maxPaybackSeconds: number;
    idleLoopMs: number;
    activeLoopMs: number;
}

export function getHacknetConfig(ns: NS): HacknetConfig {
    return {
        maxSpendFraction: getNumber(ns, "hacknet.maxSpendFraction"),
        maxPaybackSeconds: getNumber(ns, "hacknet.maxPaybackSeconds"),
        idleLoopMs: getNumber(ns, "hacknet.idleLoopMs"),
        activeLoopMs: getNumber(ns, "hacknet.activeLoopMs"),
    };
}
