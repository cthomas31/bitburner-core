export async function checkFactionServers(ns) {

    const factionFilesServerMap = {
        "csec-test.msg": "CSEC",
        "nitesec-test.msg": "avmnite-02h",
        "j3.msg": "I.I.I.I",
        "19dfj3l1nd.msg": "run4theh111z",
    }

    for (const [file, server] of Object.entries(factionFilesServerMap)) {
        if (ns.fileExists(file, "home")) {
            ns.run("scripts/singularity/find-connect-backdoor.js", 1, server);
        }
    }
}