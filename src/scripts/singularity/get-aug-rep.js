import { writeJSON } from "/lib/ns-io";

/** @param {NS} ns **/
export async function main(ns) {
  const aug = String(ns.args[0] ?? "");
  const out = String(ns.args[1] ?? "data/singularity/aug-rep.json");

  if (!aug) {
    ns.write(out, JSON.stringify({ ts: Date.now(), ok: false, error: "missing aug" }, null, 2), "w");
    return;
  }

  const repReq = ns.singularity.getAugmentationRepReq(aug);
  await writeJSON(ns, out, { ts: Date.now(), ok: true, aug, repReq });
}
