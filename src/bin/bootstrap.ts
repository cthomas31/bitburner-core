import type { NS } from "@ns";

/** @param ns NS */
export async function main(ns: NS): Promise<void> {
    ns.run("controller.js", 1);
}
