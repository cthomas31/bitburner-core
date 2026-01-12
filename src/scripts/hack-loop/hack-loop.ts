/**
 * scripts/hack-loop/hack-loop.ts
 *
 * Hack loop script that continuously hacks a specified target server.
 * It weakens the server if its security level is too high,
 * grows the server if its money is below the threshold,
 * and hacks the server otherwise.
 */

import type { NS } from "@ns";

export async function main(ns: NS): Promise<void> {
    const target = ns.args[0] as string;
    const securityMargin = ns.args[1] as number;
    const moneyThreshold = ns.args[2] as number;

    if (!target) {
        ns.tprint("Usage: run scripts/hack-once.js <target>");
        return;
    }

    for (; ;) {
        const securityLevel = ns.getServerSecurityLevel(target);
        const minSecurityLevel = ns.getServerMinSecurityLevel(target);

        const maxMoney = ns.getServerMaxMoney(target);
        const moneyAvailable = ns.getServerMoneyAvailable(target);

        if (securityLevel - minSecurityLevel > securityMargin) {
            await ns.weaken(target);
        }
        else if (moneyAvailable / maxMoney < moneyThreshold) {
            await ns.grow(target);
        }
        else {
            await ns.hack(target);
        }
        await ns.sleep(500);
    }
}
