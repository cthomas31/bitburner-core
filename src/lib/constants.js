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

// Home reserved RAM to ensure smooth operation of other tasks.
export const HOME_RESERVED_RAM = 20;

export const HACK_CONFIG = {
    // Fraction of a server's maximum money to aim for before hacking.
    moneyThreshold: 0.70,
    //
    // Additional security above a server's minimum that we're willing to tolerate before weakening.
    securityMargin: 2,
    // Maximum percentage of a server's money to attempt to hack in one go.
    hackMargin: 0.2,

    homeReservedRam: HOME_RESERVED_RAM,
};

// Money filters for scoring
export const MIN_ABSOLUTE_MONEY = 0;  // 100M; ignore servers poorer than this
export const MIN_RELATIVE_MONEY = 0; // ignore servers with <5% of best maxMoney

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
    maxTargetRam: 20480,

    // Budget per purchase: we only spend up to this fraction of current cash,
    // and we always try to keep minCashReserve in the bank.
    maxSpendFraction: 0.1,       // 10% of current money per action
    minCashReserve: 1_000_000_000,  // don’t go below this

    // ROI constraints
    roiMaxPaybackSeconds: 1 * 60 * 60, // max acceptable payback (~1 hour)
    roiMinDeltaThreads: 4,             // ignore “upgrades” that add fewer threads than this
    roiFudgeFactor: 0.5                // 0–1: downscale theoretical thread income for realism
};

// Configuration for batch-master.js to manage coordinated hack/grow/weaken batches
export const BATCHER_CONFIG = {
  // fractional portion of server.moneyMax to steal per batch (0.01 = 1%)
  hackFractionPerBatch: 0.10,

  // timing offsets (ms) to space end-times of actions within a batch.
  // These are small delays to ensure ordering. Values tuned to be safe-ish.
  // The scheduler will set startTime = baseEndTime - actionDuration - offset.
  offsets: {
    hack: 0,        // hack should finish first (base)
    weaken1: 100,   // finish slightly after hack to remove hack security
    grow: 200,      // grow should finish after weaken1
    weaken2: 300    // final weaken to remove growth security
  },

  // safety margins
  batchSpacingMs: 400,       // minimum spacing between baseEndTimes of consecutive batches
  maxConcurrentBatches: 8,   // max batches in flight (global)
  managerLoopMs: 3000,       // how often master wakes to plan new batches

  // Required scripts (paths) — ensure these match your repo.
  actionScripts: {
    hack: "/scripts/hack-once.js",
    grow: "/scripts/grow-once.js",
    weaken: "/scripts/weaken-once.js",
    timedRunner: "/scripts/batch/timed-runner.js"
  },

  // worker selection: minimum free RAM to consider a host as worker (GB)
  minWorkerFreeRam: 4,

  // debug toggles
  dryRun: false,
  verbose: true
};

