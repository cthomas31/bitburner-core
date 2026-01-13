import type { NS } from "@ns";
import type { ControllerState } from "/domain/controller/types.js";

export function freeRam(ns: NS, host = "home"): number {
    return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}

export function logSyscallRunFail(ns: NS, ctrl: ControllerState, script: string): void {
    const free = freeRam(ns, "home").toFixed(1);
    const running = ns.ps("home").map((p) => p.filename).join(", ");
    ctrl.statusMessages.push(`Syscall run failed: ${script} (free=${free}GB) running=[${running}]`);
}

export function trySyscall(
    ns: NS,
    ctrl: ControllerState,
    key: string,
    script: string,
    args: (string | number | boolean)[] = [],
    retryMs = 1000
): number {
    if (!ns.fileExists(script, "home")) {
        ctrl.statusMessages.push(`Syscall failed: missing script ${script}`);
        return 0;
    }

    const now = Date.now();
    if (!ctrl.ensureBackoff) ctrl.ensureBackoff = {};
    const nextOk = ctrl.ensureBackoff[key] ?? 0;
    if (now < nextOk) return 0;

    const pid = ns.run(script, 1, ...args);
    if (pid === 0) {
        ctrl.ensureBackoff[key] = now + retryMs;
        logSyscallRunFail(ns, ctrl, script);
        return 0;
    }

    delete ctrl.ensureBackoff[key];
    return pid;
}
