/** @param {NS} ns **/
export async function main(ns) {
    const target = ns.args[0];
    if (!target) {
        //ns.tprint("Usage: run scripts/weaken-once.js <target>");
        return;
    }
    await ns.weaken(target);
}
