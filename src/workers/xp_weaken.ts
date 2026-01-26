/**
 * XP weaken-only worker.
 *
 * Usage:
 *   run /workers/xp_weaken.js <target>
 */
import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    const target = String(ns.args[0] ?? "");
    if (!target) {
        ns.tprint("[xp-weaken] No target specified.");
        return;
    }

    const threads = ns.getRunningScript()?.threads ?? 1;
    ns.print(`[xp-weaken] host=${ns.getHostname()} target=${target} threads=${threads}`);

    for (;;) {
        await ns.weaken(target);
    }
}
