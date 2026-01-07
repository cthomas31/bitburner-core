import { writeJSON } from "/lib/ns-io";

/** @param {NS} ns **/
export async function main(ns) {
  const faction = String(ns.args[0] ?? "");
  const out = String(ns.args[1] ?? "data/singularity/join-faction.json");

  if (!faction) {
    ns.write(out, JSON.stringify({ ts: Date.now(), ok: false, error: "missing faction" }, null, 2), "w");
    return;
  }

  const ok = ns.singularity.joinFaction(faction);
  await writeJSON(ns, out, { ts: Date.now(), faction, ok });
}
