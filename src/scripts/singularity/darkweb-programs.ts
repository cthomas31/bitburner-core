/**
 * scripts/singularity/darkweb-programs.ts
 *
 * Check for missing darkweb programs and attempt to purchase them.
 */

import type { NS } from "@ns";

/**
 * Get list of required darkweb programs and purchase any that are missing.
 */
export async function getDarkwebPrograms(ns: NS): Promise<void> {
    const programs = [
        "BruteSSH.exe",
        "FTPCrack.exe",
        "relaySMTP.exe",
        "HTTPWorm.exe",
        "SQLInject.exe"
    ];

    const neededPrograms = programs.filter(prog => !ns.fileExists(prog, "home"));

    for (const program of neededPrograms) {
        ns.run("scripts/singularity/purchase-program.js", 1, program);
    }
}
