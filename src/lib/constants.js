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
export const MIN_ABSOLUTE_MONEY = 0;  // 100M; ignore servers poorer than this
export const MIN_RELATIVE_MONEY = 0; // ignore servers with <5% of best maxMoney

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

// Configuration for hacknet-manager.js to automate Hacknet Node upgrades
export const HACKNET_CONFIG = {
    // Don't spend more than this fraction of current money on a single purchase.
    maxSpendFraction: 0.1,          // 10% of cash per action

    // Max acceptable payback horizon for an upgrade (in seconds).
    // 6 hours is a nice mid-game default. Bump to 12h if you’re patient,
    // drop to 1–2h if you’re about to install augments.
    maxPaybackSeconds: 6 * 60 * 60,   // 6 hours

    // How often the manager loops when it can’t find a good upgrade.
    idleLoopMs: 30_000,

    // How often it loops when it *is* actively buying stuff.
    activeLoopMs: 50,
};

// Configuration for pserv-manager.js to automate purchased server management

export const PSERV_CONFIG = {
    enabled: true,

    hostnamePrefix: "pserv-",
    maxServers: 25,

    // Minimum RAM tier (GB) we’ll consider for new servers.
    baseRam: 8,

    // Max RAM tier we’re willing to target (GB).
    // Clamped to ns.getPurchasedServerMaxRam() at runtime.
    maxTargetRam: 2048,

    // Budget per purchase: we only spend up to this fraction of current cash,
    // and we always try to keep minCashReserve in the bank.
    maxSpendFraction: 0.1,       // 10% of current money per action
    minCashReserve: 5_000_000_000,  // don’t go below this

    // ROI constraints
    roiMaxPaybackSeconds: 1 * 60 * 60, // max acceptable payback (~1 hour)
    roiMinDeltaThreads: 4,             // ignore “upgrades” that add fewer threads than this
    roiFudgeFactor: 0.5                // 0–1: downscale theoretical thread income for realism
};
