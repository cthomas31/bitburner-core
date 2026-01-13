/**
 * Run killall on all rooted servers.
 *
 * Usage: run bin/stop-all.js
 */

import type { NS } from "@ns";
import { getRootedServers } from "/lib/network.js";

export async function main(ns: NS): Promise<void> {
    ns.disableLog("scan");
    ns.disableLog("killall");

    const hosts = await getRootedServers(ns);

    for (const host of hosts) {
        if (host === "home") continue;

        ns.killall(host);
        ns.tprint(`[stop-all] ${host}: killed all scripts`);
    }
}
