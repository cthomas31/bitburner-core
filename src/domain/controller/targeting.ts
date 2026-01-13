import type { NS } from "@ns";
import { readJSON } from "/lib/ns/io.js";
import type { ControllerConfig, ControllerState, TargetEntry } from "/domain/controller/types.js";

// Pick best target from targets.json
export async function pickBestTarget(
    ns: NS,
    CFG: ControllerConfig,
    hackLevel: number
): Promise<TargetEntry | null> {
    if (!ns.fileExists(CFG.targetsFile, "home")) return null;
    try {
        const rows = (await readJSON(ns, CFG.targetsFile)) as Array<{
            host?: string;
            score?: number;
            reqHack?: number;
            maxMoney?: number;
        }> | null;
        if (!Array.isArray(rows)) return null;
        const usable = rows
            .filter((r) => r && typeof r.host === "string")
            .filter((r) => ns.serverExists(r.host as string))
            .filter((r) => ns.hasRootAccess(r.host as string))
            .filter(
                (r) =>
                    (r.reqHack ??
                        ns.getServerRequiredHackingLevel(r.host as string)) <=
                    hackLevel
            )
            .filter(
                (r) =>
                    (r.maxMoney ?? ns.getServerMaxMoney(r.host as string)) > 0
            )
            .map((r) => ({
                host: r.host as string,
                score: Number(r.score ?? 0),
            }));
        usable.sort((a, b) => b.score - a.score);
        return usable[0] ?? null;
    } catch {
        return null;
    }
}

// Choose whether to stick to last target or switch to best target
export function chooseStickyTarget(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    hackLevel: number,
    best: TargetEntry | null
): TargetEntry | null {
    const cur = ctrl.lastTarget;

    if (!best)
        return cur ? { host: cur, score: ctrl.lastTargetScore || 0 } : null;

    if (!cur) {
        ctrl.lastTarget = best.host;
        ctrl.lastTargetScore = best.score;
        return best;
    }

    if (!isValid(ns, cur, hackLevel)) {
        ctrl.lastTarget = best.host;
        ctrl.lastTargetScore = best.score;
        return best;
    }

    const curScore = ctrl.lastTargetScore || 0;
    if (curScore <= 0) {
        ctrl.lastTarget = best.host;
        ctrl.lastTargetScore = best.score;
        return best;
    }

    if (
        best.host !== cur &&
        best.score >= curScore * CFG.targetSwitchMinImprovement
    ) {
        ctrl.lastTarget = best.host;
        ctrl.lastTargetScore = best.score;
        return best;
    }

    return { host: cur, score: curScore };
}

// Check if target is valid for hacking
export function isValid(ns: NS, host: string, hackLevel: number): boolean {
    return (
        ns.serverExists(host) &&
        ns.hasRootAccess(host) &&
        ns.getServerMaxMoney(host) > 0 &&
        ns.getServerRequiredHackingLevel(host) <= hackLevel
    );
}