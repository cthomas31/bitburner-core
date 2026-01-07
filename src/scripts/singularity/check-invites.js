import { writeJSON } from "/lib/ns-io";

/** @param {NS} ns **/
export async function main(ns) {
  const out = String(ns.args[0] ?? "data/singularity/invites.json");

  const invites = ns.singularity.checkFactionInvitations();
  await writeJSON(ns, out, { ts: Date.now(), invites });
}
