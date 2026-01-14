/**
 * scripts/singularity/check-faction-servers.ts
 *
 * Check for faction server invitation files and attempt to connect/backdoor them.
 */

import type { NS } from "@ns";

/**
 * Check for faction-related message files and attempt to backdoor the corresponding servers.
 * Maps faction invitation files to their associated server hostnames.
 */
export async function checkFactionServers(ns: NS): Promise<void> {
    const factionFilesServerMap: Record<string, string> = {
        "csec-test.msg": "CSEC",
        "nitesec-test.msg": "avmnite-02h",
        "j3.msg": "I.I.I.I",
        "19dfj3l1nd.msg": "run4theh111z",
    };

    for (const [file, server] of Object.entries(factionFilesServerMap)) {
        if (ns.fileExists(file, "home")) {
            ns.run("app/hacking/find-connect-backdoor.js", 1, server);
            await ns.sleep(1000);
        }
    }
}
