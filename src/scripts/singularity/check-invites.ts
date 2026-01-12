/**
 * scripts/singularity/check-invites.ts
 *
 * Check for faction invitations and write them to a JSON file.
 */

import type { NS } from "@ns";
import { writeJSON } from "/lib/ns-io";

export async function main(ns: NS): Promise<void> {
    const out = String(ns.args[0] ?? "data/singularity/invites.json");

    const invites = ns.singularity.checkFactionInvitations();
    await writeJSON(ns, out, { ts: Date.now(), invites });
}
