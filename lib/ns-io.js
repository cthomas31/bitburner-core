/**
 * ns-io.js
 *
 * Utility functions for reading and writing files in JSON format.
 * These helpers wrap ns.read/ns.write to automatically handle JSON parsing.
 * When a file is missing or cannot be parsed, readJSON returns null rather than throwing.
 */

/**
 * Read a JSON file from disk.
 *
 * @param {NS} ns - Bitburner namespace provided by the game.
 * @param {string} path - Path to the JSON file.
 * @returns {Promise<any|null>} Parsed JSON content, or null if file doesn't exist or is malformed.
 */
export async function readJSON(ns, path) {
  try {
    const data = ns.read(path);
    return data ? JSON.parse(data) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Write a JavaScript value as JSON to disk.
 *
 * @param {NS} ns - Bitburner namespace provided by the game.
 * @param {string} path - Path to the JSON file.
 * @param {any} content - The data to write; will be stringified.
 * @returns {Promise<void>} Resolves once the file has been written.
 */
export async function writeJSON(ns, path, content) {
  const json = JSON.stringify(content, null, 2);
  await ns.write(path, json, "w");
}