/**
 * Weaken loop script that continuously weakens a specified target server.
 *  
 * @param {NS} ns 
 * 
 **/
export async function main(ns) {
    const target = ns.args[0];
    if (!target) {
        ns.tprint("Usage: run scripts/weaken-loop.js <target>");
        return;
    }
    for (;;) {
        await ns.weaken(target);
        await ns.sleep(500);
    }
}
