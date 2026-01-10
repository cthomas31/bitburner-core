import { writeJSON } from "/lib/ns-io.js";

/** @param {NS} ns **/
export async function main(ns) {
  const out = String(ns.args[0] ?? "data/singularity/purchase-tor.json");

  const ok = ns.singularity.purchaseTor();
  await writeJSON(ns, out, { ts: Date.now(), ok });
}
