/**
 * ns-io.ts
 *
 * Utility functions for reading and writing files in JSON format.
 * These helpers wrap ns.read/ns.write to automatically handle JSON parsing.
 * When a file is missing or cannot be parsed, readJSON returns null rather than throwing.
 */

import type { NS } from "@ns";

/**
 * Read a JSON file from disk.
 *
 * @param ns - Bitburner namespace provided by the game.
 * @param path - Path to the JSON file.
 * @returns Parsed JSON content, or null if file doesn't exist or is malformed.
 */
export async function readJSON(ns: NS, path: string): Promise<unknown | null> {
    try {
        const data = ns.read(path);
        return data ? JSON.parse(data) : null;
    } catch {
        return null;
    }
}

/**
 * Write a JavaScript value as JSON to disk.
 *
 * @param ns - Bitburner namespace provided by the game.
 * @param path - Path to the JSON file.
 * @param content - The data to write; will be stringified.
 */
export function writeJSON(ns: NS, path: string, content: unknown): void {
    const json = JSON.stringify(content, null, 2);
    ns.write(path, json, "w");
}
