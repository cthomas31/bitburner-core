import type { NS } from "@ns";

export type ArgSpec =
    | { name: string; kind: "string"; optional?: boolean }
    | { name: string; kind: "number"; optional?: boolean }
    | { name: string; kind: "boolean"; optional?: boolean };

/** Parse an argument from ns.args based on the provided ArgSpec.
 *
 * @param ns
 * @param idx The index in ns.args to parse.
 * @param spec The specification of the argument to parse.
 * @returns The parsed argument value.
 */
export function parseArg(ns: NS, idx: number, spec: ArgSpec): unknown {
    const raw = ns.args[idx];
    if (raw == null) return null;

    switch (spec.kind) {
        case "string":
            return String(raw);
        case "number": {
            const n = Number(raw);
            return Number.isFinite(n) ? n : NaN;
        }
        case "boolean":
            return Boolean(raw);
    }
}

/** Check if a parsed argument is considered "missing" based on its ArgSpec.
 *
 * @param val The parsed argument value.
 * @param spec The specification of the argument.
 * @returns True if the argument is missing, false otherwise.
 */
export function missingArg(val: unknown, spec: ArgSpec): boolean {
    if (val === null) return true;
    if (spec.kind === "string" && String(val).length === 0) return true;
    if (spec.kind === "number" && typeof val === "number" && Number.isNaN(val))
        return true;
    return false;
}
