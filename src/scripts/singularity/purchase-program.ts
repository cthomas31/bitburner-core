/**
 * scripts/singularity/purchase-program.ts
 *
 * Purchase a program from the darkweb and write the result to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [{ name: "programName", kind: "string" }],
    run: ({ programName }) => {
      const p = String(programName);
      const ok = ns.singularity.purchaseProgram(p);
      return { programName: p, ok };
    },
  });
}
