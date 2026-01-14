import type { NS } from "@ns";
import { getNumber, getString } from "/lib/settings.js";

export interface TargetConfig {
    networkFile: string;
    targetsFile: string;
    filters: {
        minAbsoluteMoney: number;
        minRelativeMoney: number;
    };
}

export function getTargetConfig(ns: NS): TargetConfig {
    return {
        networkFile: getString(ns, "paths.networkFile"),
        targetsFile: getString(ns, "paths.targetsFile"),
        filters: {
            minAbsoluteMoney: getNumber(ns, "targets.filters.minAbsoluteMoney"),
            minRelativeMoney: getNumber(ns, "targets.filters.minRelativeMoney"),
        },
    };
}
