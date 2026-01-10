import { writeJSON } from "/lib/ns-io";

/** @param {NS} ns **/
export async function main(ns) {
  const out = ns.args[0] ?? "data/singularity/owned-augs.json";

  const installed = ns.singularity.getOwnedAugmentations(false);
  const owned = ns.singularity.getOwnedAugmentations(true);

  const installedSet = new Set(installed);
  const pending = owned.filter(a => !installedSet.has(a));

  await writeJSON(ns, out, { ts: Date.now(), installed, owned, pending, pendingCount: pending.length });
}
