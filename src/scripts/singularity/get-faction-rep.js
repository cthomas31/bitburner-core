import { writeJSON } from "/lib/ns-io";

/** @param {NS} ns **/
export async function main(ns) {
  const faction = String(ns.args[0] ?? "");
  const out = ns.args[1] ?? "data/singularity/get-faction-rep.json";

  const rep = ns.singularity.getFactionRep(faction);
  await writeJSON(ns, out, { ts: Date.now(), faction, rep });
}
