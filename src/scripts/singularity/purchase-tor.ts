/**
 * scripts/singularity/purchase-tor.ts
 *
 * Purchase the TOR router and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [],
    run: () => {
      const ok = ns.singularity.purchaseTor();
      return { ok };
    },
  });
}
