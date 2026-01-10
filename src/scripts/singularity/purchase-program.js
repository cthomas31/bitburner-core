import { writeJSON } from "/lib/ns-io.js";

/** @param {NS} ns **/
export async function main(ns) {
  const program = String(ns.args[0] ?? "");
  const out = String(ns.args[1] ?? "data/singularity/purchase-program.json");

  let ok = false;
  ok = ns.hasTorRouter() && ns.singularity.purchaseProgram(program);
  await writeJSON(ns, out, { ts: Date.now(), program, ok });
}
