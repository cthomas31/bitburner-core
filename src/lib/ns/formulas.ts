import type { NS } from "@ns";

export function hasFormulas(ns: NS): boolean {
    return ns.fileExists("Formulas.exe", "home") && !!ns.formulas?.hacking;
}