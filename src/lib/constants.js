/** 
 * constants.js
 *
 * Shared configuration values for early game hacking scripts.
 * Adjust these values to tune how aggressively your scripts hack servers.
 */

// Path to the JSON file where scan-network.js writes discovered server data.
export const NETWORK_FILE = "/data/network.json";

// Path to the JSON file where score-targets.js writes sorted target data.
export const TARGETS_FILE = "/data/targets.json";

// Fraction of a server's maximum money we aim to preserve before initiating a hack.
// A higher number means the script waits until the server is very full of money before hacking,
// resulting in slower hacks but less risk of running the server dry.
export const MONEY_THRESHOLD = 0.75;

// Money filters for scoring
export const MIN_ABSOLUTE_MONEY = 1e8;  // 100M; ignore servers poorer than this
export const MIN_RELATIVE_MONEY = 0.03; // ignore servers with <30% of best maxMoney

// Additional security above a server's minimum that we're willing to tolerate before weakening.
// A small margin keeps the server closer to its minimum security level but will devote more time to weaken.
export const SECURITY_MARGIN = 3;

// Maximum percentage of a server's money to attempt to hack in one go.
export const HACK_MARGIN = 0.1; 

// Percentage of available RAM to use on each server when launching hack-loop threads.
// Leaving a buffer reduces the chance of over-allocating RAM and crashing other scripts.
export const THREAD_BUFFER = 0.9;

// Amount of RAM (in GB) to reserve on the 'home' server to ensure smooth operation of other tasks.
export const HOME_RESERVED_RAM = 64;

// Whether to deploy hack-loop.js on the 'home' server in addition to other rooted servers.
export const HOME_HACK_LOOP_DEPLOY = true;