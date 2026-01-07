/** @param {NS} ns */
export async function main(ns) {
    if (!ns.gang || !ns.gang.inGang()) {
        ns.tprint("Not in a gang.");
        return;
    }

    const tasks = ns.gang.getTaskNames();
    for (const t of tasks) {
        const s = ns.gang.getTaskStats(t);
        ns.tprint(`${t}:
  isHacking=${s.isHacking} isViolent=${s.isViolent}
  hack=${s.hackWeight}  str=${s.strWeight}  def=${s.defWeight}
  dex=${s.dexWeight}    agi=${s.agiWeight}  cha=${s.chaWeight}`);
    }
}
