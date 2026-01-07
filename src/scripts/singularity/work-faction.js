import { writeJSON } from "/lib/ns-io";

/** @param {NS} ns **/
export async function main(ns) {
  const faction = String(ns.args[0] ?? "");
  const workType = String(ns.args[1] ?? "hacking"); // hacking | field | security
  const focus = Boolean(ns.args[2] ?? false);
  const out = ns.args[3] ?? "data/singularity/work-faction.json";

  const ok = ns.singularity.workForFaction(faction, workType, focus);
  await writeJSON(ns, out, { ts: Date.now(), faction, workType, focus, ok });
}
