import type { NS } from "@ns";
import type { ControllerConfig, ControllerState } from "/domain/controller/types.js";

export function pickMoneyFirstMode(hackLevel: number, batchFromHacking: number, formulas: boolean): string {
    if (hackLevel >= batchFromHacking) return formulas ? "BATCH" : "HGW";
    return "HGW";
}

export function reconcileWorkload(ns: NS, CFG: ControllerConfig, ctrl: ControllerState, mode: string, target: string): void {
    const changed = ctrl.lastMode !== mode || ctrl.lastTargetApplied !== target;
    if (!changed) return;

    kill(ns, CFG.hgwOrchestrator);
    kill(ns, CFG.batchOrchestrator);
    kill(ns, CFG.xpDeploy);

    ctrl.lastMode = mode;
    ctrl.lastTargetApplied = target;

    ctrl.ensureBackoff = {};
    // xp-deploy is a one-shot deploy script; arm it only when entering XP mode
    ctrl.xpDeployArmed = mode === "XP";
}

export function ensureDesiredRunning(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    mode: string,
    target: string,
    formulas: boolean
): void {
    if (mode === "HGW") {
        ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [target]);
    } else if (mode === "BATCH") {
        if (formulas) ensureOnce(ns, ctrl, CFG.batchOrchestrator);
        else ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [target]);
    } else if (mode === "XP") {
        if (ctrl.xpDeployArmed) {
            const pid = ns.run(CFG.xpDeploy, 1, CFG.xpTargetCount);
            if (pid !== 0) {
                ctrl.xpDeployArmed = false;
                ns.print("XP deploy armed -> running once");
            }
        }
    }
}

export function ensureOnce(
    ns: NS,
    ctrl: ControllerState,
    script: string,
    args: (string | number | boolean)[] = [],
    retryMs = 500
): void {
    if (!ns.fileExists(script, "home")) return;

    const key = `${script} ${JSON.stringify(args)}`;
    const now = Date.now();
    const nextOk = ctrl.ensureBackoff?.[key] ?? 0;
    if (now < nextOk) return;

    if (ns.isRunning(script, "home", ...args)) {
        delete ctrl.ensureBackoff[key];
        return;
    }

    const pid = ns.run(script, 1, ...args);
    if (pid === 0) {
        ctrl.ensureBackoff[key] = now + retryMs;
    } else {
        delete ctrl.ensureBackoff[key];
    }
}

export function kill(ns: NS, script: string): void {
    if (ns.fileExists(script, "home") && ns.isRunning(script, "home")) ns.kill(script, "home");
}
