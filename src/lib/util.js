/**
 * util.js
 *
 * Miscellaneous helper functions for formatting and calculations.
 */

/**
 * Convert a number into a human-readable string with suffixes for thousands,
 * millions and billions. Useful for logging large money values.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatMoney(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "b";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "m";
  if (abs >= 1e3) return (n / 1e3).toFixed(2) + "k";
  return n.toFixed(2);
}