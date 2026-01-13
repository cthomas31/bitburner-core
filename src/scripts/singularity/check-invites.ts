/**
 *
 * Check for faction invitations and write them to a JSON file.
 */

import type { NS } from "@ns";
import { oneShot } from "/lib/singularity.js";

export async function main(ns: NS): Promise<void> {
  return oneShot(ns, {
    args: [],
    run: () => {
      const invites = ns.singularity.checkFactionInvitations();
      return { invites: invites };
    },
  });
}
