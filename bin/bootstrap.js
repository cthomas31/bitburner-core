/**
 * bootstrap.js
 *
 * One-time setup script to initialize persistent data files and then
 * start the early-game automation. Useful when first importing this
 * script suite into a fresh Bitburner installation.
 *
 * Usage: run bin/bootstrap.js
 */

/** @param {NS} ns */
export async function main(ns) {
  // Initialize data files if they don't exist. Using ns.write with mode "w" will
  // create the file or overwrite it. We'll only write empty structures if the
  // files don't already exist.
  const networkFile = '/data/network.json';
  const targetsFile = '/data/targets.json';
  if (!ns.fileExists(networkFile, 'home')) {
    await ns.write(networkFile, '{}', 'w');
  }
  if (!ns.fileExists(targetsFile, 'home')) {
    await ns.write(targetsFile, '[]', 'w');
  }
  // Launch the start script to scan, score and deploy hacks
  ns.run('bin/start.js', 1);
}