/** @param {NS} ns **/
export async function main(ns) {
    const target = ns.args[0];
    if (!target) {
        ns.tprint("Usage: run scripts/grow-once.js <target>");
        return;
    }
    await ns.grow(target);
}
