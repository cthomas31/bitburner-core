/**
 *
 * Install all pending augmentations and restart with the specified bootstrap script.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "cbScript", kind: "string" }],
    run: ({ cbScript }) => {
      const cb = String(cbScript);
      ns.singularity.installAugmentations(cb);
      return {};
    },
  });
}
