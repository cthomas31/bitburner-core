import type { NS } from "@ns";
import type { ControllerConfig, ControllerState, TargetEntry } from "/domain/controller/types.js";
import { freeRam } from "/domain/controller/syscalls.js";

/**
 * Draw controller UI. Domain-friendly: does NOT depend on StockManager.
 * Caller passes stock status lines.
 */
export async function drawUI(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    best: TargetEntry | null,
    mode: string,
    target: string,
    hack: number,
    formulas: boolean,
    stockLines: string[]
): Promise<void> {
    ns.clearLog();

    ns.print(`Mode: ${mode} | Target: ${target}`);
    if (best)
        ns.print(
            `BestNow: ${best.host} (${best.score.toFixed(2)}) | Sticky: ${
                ctrl.lastTarget
            } (${(ctrl.lastTargetScore || 0).toFixed(2)})`
        );

    ns.print(`Hack: ${hack} | Formulas.exe: ${formulas ? "YES" : "NO"}`);

    const free = freeRam(ns, "home");
    ns.print(`Home RAM: free=${free.toFixed(1)}GB`);

    if (CFG.enableFactions) {
        ns.print(
            `Faction: ${ctrl.chosenFaction ?? "(none)"} | Rep: ${Math.floor(
                ctrl.factionRep ?? 0
            )}`
        );
    }
    else {
        ns.print(`Factions: DISABLED`);
    }
    if (CFG.enableAugs) {
        ns.print(
            `PendingAugs: ${ctrl.pendingAugsCount} | InstallCD: ${Math.max(
                0,
                Math.floor(
                    (CFG.installCooldownMs - (Date.now() - ctrl.lastInstallTs)) /
                        1000
                )
            )}s`
        );
    }
    else {
        ns.print(`Augs: DISABLED`);
    }

    ns.print(
        `Syscall: ${
            ctrl.syscallPid
                ? `PID ${ctrl.syscallPid} (${ctrl.syscallKey})`
                : "idle"
        }`
    );
    ns.print(
        `scan-score: ${
            ns.isRunning(CFG.scanScore, "home") ? "RUNNING" : "idle"
        }`
    );

    if (ctrl.pendingPurchase) {
        ns.print(
            `PendingPurchase: ${ctrl.pendingPurchase.aug} @ ${ctrl.pendingPurchase.faction}`
        );
    }

    for (const line of stockLines) ns.print(line);

    if (ctrl.statusMessages?.length) {
        ctrl.statusMessages = ctrl.statusMessages.slice(-8);
        ns.print("--- status ---");
        for (const m of ctrl.statusMessages) ns.print(m);
    }
}
