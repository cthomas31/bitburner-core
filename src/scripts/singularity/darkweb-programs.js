export async function getDarkwebPrograms(ns) {

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