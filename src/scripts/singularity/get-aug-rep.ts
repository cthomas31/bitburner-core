/**
 * scripts/singularity/get-aug-rep.ts
 *
 * Get the reputation requirement for an augmentation and write to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
    return oneShot(ns, {
        args: [
            { name: "aug", kind: "string" },
        ],
        run: ({ aug }) => {
            const a = String(aug);
            const repReq = ns.singularity.getAugmentationRepReq(a);
            return { aug: a, repReq };
        },
    });
}