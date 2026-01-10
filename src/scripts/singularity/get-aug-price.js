import { writeJSON } from "lib/ns-io.js";
/** @param {NS} ns **/
export async function main(ns) {
  const aug = String(ns.args[0] ?? "");
  const out = String(ns.args[1] ?? "data/singularity/aug-price.json");

  if (!aug) {
    await writeJSON(ns, out, { ts: Date.now(), ok: false, error: "missing aug" });
    return;
  }

  const price = ns.singularity.getAugmentationPrice(aug);
  await writeJSON(ns, out, { ts: Date.now(), ok: true, aug, price });
}
