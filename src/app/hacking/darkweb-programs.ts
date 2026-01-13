/**
 * Check for missing darkweb programs and attempt to purchase them.
 */

import type { NS } from "@ns";
import { run } from "/lib/singularity.js";

/**
 * Get list of required darkweb programs and purchase any that are missing.
 */
export async function getDarkwebPrograms(ns: NS): Promise<unknown[]> {
    const programs = [
        "BruteSSH.exe",
        "FTPCrack.exe",
        "relaySMTP.exe",
        "HTTPWorm.exe",
        "SQLInject.exe"
    ];

    const neededPrograms = programs.filter(prog => !ns.fileExists(prog, "home"));

    const results = [];
    for (const program of neededPrograms) {
        const res = run(ns, "purchase-program", [program]);
        results.push(res);
    }
    return results;
}
