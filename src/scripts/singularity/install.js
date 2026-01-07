import { writeJSON } from "/lib/ns-io";

/** @param {NS} ns **/
export async function main(ns) {
  const bootstrap = String(ns.args[0] ?? "bootstrap.js");
  const out = ns.args[1] ?? "data/singularity/install.json";
  const ok = ns.singularity.installAugmentations(bootstrap);
  await writeJSON(ns, out, { ts: Date.now(), bootstrap, ok });
}
