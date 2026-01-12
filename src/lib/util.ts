/**
 * util.ts
 *
 * Miscellaneous helper functions for formatting and calculations.
 */

/**
 * Convert a number into a human-readable string with suffixes for thousands,
 * millions and billions. Useful for logging large money values.
 */
export function formatMoney(n: number): string {
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(2) + "b";
    if (abs >= 1e6) return (n / 1e6).toFixed(2) + "m";
    if (abs >= 1e3) return (n / 1e3).toFixed(2) + "k";
    return n.toFixed(2);
}

/**
 * Format a time duration given in milliseconds into a string with minutes and seconds.
 */
export function formatTime(ms: number): string {
    const totalSeconds = ms / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    const minuteLabel = minutes === 1 ? "minute" : "minutes";
    const minutesPart = minutes > 0 ? `${minutes} ${minuteLabel} ` : "";

    return `${minutesPart}${seconds.toFixed(2)} seconds`;
}
