/**
 * find.ts
 *
 * Find a host by name and print the path from "home" to that host.
 * Also prints a one-liner you can paste to connect step-by-step.
 *
 * Usage: run bin/find.js <target-hostname>
 *
 * Dependencies: lib/network.js
 */

import type { NS } from "@ns";
import { findPath } from "/lib/network.js";

/** @param ns NS */
export async function main(ns: NS): Promise<void> {
    const args = ns.flags([["help", false]]) as { help: boolean; _: string[] };
    if (args.help || args._.length !== 1) {
        ns.tprint("Usage: run bin/find.js <target-hostname>");
        return;
    }

    const target = args._[0];
    const start = "home";
    const path = await findPath(ns, target, start);
    if (path === null) {
        ns.tprint(`find: target "${target}" is not reachable from "${start}"`);
        return;
    }

    // Pretty path
    ns.tprint(`Path to ${target}:`);
    ns.tprint(path.join(" -> "));

    // Command chain: connect a ; connect b ; connect c
    const connectCmd = path
        .filter((h: string) => h !== "home") // you already start on home
        .map((h: string) => `connect ${h}`)
        .join(" ; ");

    ns.tprint("Connect command:");
    ns.tprint(connectCmd);
}
