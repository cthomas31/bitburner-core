import { writeJSON } from "/lib/ns-io";

/** @param {NS} ns **/
export async function main(ns) {
  const faction = String(ns.args[0] ?? "");
  const amount = Number(ns.args[1] ?? 0);
  const out = ns.args[2] ?? "data/singularity/donate.json";

  const ok = ns.singularity.donateToFaction(faction, amount);
  await writeJSON(ns, out, { ts: Date.now(), faction, amount, ok });
}
