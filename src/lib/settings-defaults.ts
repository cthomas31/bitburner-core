export const DEFAULT_SETTINGS: Record<string, unknown> = {
    // Paths
    "paths.networkFile": "/data/network.json",
    "paths.targetsFile": "/data/targets.json",

    // Controller
    "controller.tickMs": 2000,
    "controller.scanEveryMs": 5 * 60 * 1000,
    "controller.scripts.scanScore": "/bin/scan-score.js",
    "controller.scripts.hgwOrchestrator": "/app/hacking/strategy-hgw.js",
    "controller.scripts.batchOrchestrator": "/app/hacking/strategy-batch.js",
    "controller.scripts.xpDeploy": "/app/hacking/xp-deploy.js",
    "controller.scripts.gangManager": "/app/gang/manager.js",
    "controller.scripts.pservManager": "/app/pserv/manager.js",
    "controller.flags.enableGangManager": false,
    "controller.flags.enablePservManager": false,
    "controller.flags.enableDarkwebChecks": false,
    "controller.flags.enableCheckFactionServers": false,
    "controller.augs.enable": true,
    "controller.factions.enable": true,
    "controller.hacking.batchFromHacking": 800,
    "controller.targets.switchMinImprovement": 1.15,

    // Controller: singularity + factions
    "controller.paths.singularityDir": "/data/singularity",
    "controller.syscalls.darkweb.everyMs": 5 * 60 * 1000,
    "controller.syscalls.factionServers.everyMs": 5 * 60 * 1000,
    "controller.syscalls.factions.joinInvitesEveryMs": 5 * 60 * 1000,
    "controller.syscalls.factions.workEveryMs": 60 * 1000,
    "controller.syscalls.augs.ownedEveryMs": 60 * 1000,
    "controller.syscalls.augs.fromFactionEveryMs": 5 * 60 * 1000,
    "controller.syscalls.augs.repEveryMs": 30 * 1000,
    "controller.syscalls.augs.probeEveryMs": 1500,
    "controller.syscalls.augs.statsEveryMs": 3500,
    "controller.syscalls.augs.prereqsEveryMs": 3500,
    "controller.syscalls.augs.buyCooldownMs": 2500,
    "controller.augs.buy.repReachBuffer": 25_000,
    "controller.augs.buy.maxSpendFraction": 0.35,
    "controller.augs.buy.minCashReserve": 5e8,
    "controller.augs.cache.maxFacts": 75,
    "controller.augs.install.cooldownMs": 10 * 60 * 1000,
    "controller.augs.install.minPending": 8,
    "controller.factions.priority": [
        "Sector-12",
        "CyberSec",
        "NiteSec",
        "The Black Hand",
        "BitRunners",
        "Tian Di Hui",
        "Daedalus",
        "Aevum",
        "Volhaven",
        "Chongqing",
        "New Tokyo",
        "Ishima",
    ],
    "controller.factions.workType": "hacking",
    "controller.factions.enableDonations": false,
    "controller.factions.chooser.repCacheMs": 5 * 60 * 1000,
    "controller.factions.chooser.augsCacheMs": 15 * 60 * 1000,
    "controller.factions.chooser.repGapPenalty": 1.0,
    "controller.factions.chooser.buyNowBonus": 1e9,
    "controller.factions.chooser.crossFactionPrereqPenalty": 0.25,

    // Hacking tuning
    "hacking.moneyThreshold": 0.7,
    "hacking.securityMargin": 2,
    "hacking.hackMargin": 0.2,
    "hacking.homeReservedRam": 256,

    // Hacknet
    "hacknet.maxSpendFraction": 0.1,
    "hacknet.maxPaybackSeconds": 6 * 60 * 60,
    "hacknet.idleLoopMs": 30_000,
    "hacknet.activeLoopMs": 50,

    // Purchased servers
    "pserv.enabled": false,
    "pserv.hostnamePrefix": "pserv-",
    "pserv.maxServers": 25,
    "pserv.baseRam": 8,
    "pserv.maxTargetRam": 20_480,
    "pserv.maxSpendFraction": 0.1,
    "pserv.minCashReserve": 1_000_000_000,
    "pserv.roi.maxPaybackSeconds": 1 * 60 * 60,
    "pserv.roi.minDeltaThreads": 4,
    "pserv.roi.fudgeFactor": 0.5,
    "pserv.manager.threadIncomePerSec": 10_000,
    "pserv.manager.idleLoopMs": 60_000,
    "pserv.manager.activeLoopMs": 5_000,

    // Stocks
    "stocks.rebalanceMs": 6000,
    "stocks.cooldownMs": 20_000,
    "stocks.cooldownTicks": 0,
    "stocks.decisionIntervalTicks": 1,
    "stocks.maxActionsPerTick": 6,
    "stocks.minHoldAfterEntryTicks": 30,
    "stocks.minTradeIntervalTicks": 15,
    "stocks.logFile": "/logs/stock-manager.txt",
    "stocks.use4S": true,
    "stocks.forecast.enterLong": 0.6,
    "stocks.forecast.exitLong": 0.55,
    "stocks.forecast.enterShort": 0.4,
    "stocks.forecast.exitShort": 0.45,
    "stocks.history.priceHistoryMax": 80,
    "stocks.history.emaFast": 6,
    "stocks.history.emaSlow": 24,
    "stocks.history.trendEnter": 0.002,
    "stocks.history.trendExit": 0.0,
    "stocks.sizing.maxSymbolFrac": 0.1,
    "stocks.sizing.maxTotalFrac": 0.8,
    "stocks.sizing.maxOpenSymbols": 8,
    "stocks.sizing.minDeltaShares": 10,
    "stocks.sizing.minOrderNotional": 5_000_000,
    "stocks.sizing.positionToleranceFrac": 0.05,
    "stocks.cash.minCashAbs": 40_000_000,
    "stocks.cash.minCashFrac": 0.1,
    "stocks.risk.maxDrawdownFrac": 0.15,
    "stocks.risk.pauseAfterKillMs": 5 * 60 * 1000,
    "stocks.externalSpendResetFrac": 0.5,
    "stocks.resetEquityPeakOnBoot": false,
    "stocks.trend.longOnly": true,
    "stocks.trend.maxSymbolFrac": 0.02,
    "stocks.trend.maxTotalFrac": 0.2,
    "stocks.trend.maxSpreadFrac": 0.003,
    "stocks.trend.minPrice": 5000,
    "stocks.trend.minSignalFrac": 0.004,
    "stocks.trend.spreadEdgeBufferFrac": 0.001,

    // Batcher
    "batcher.tickMs": 125,
    "batcher.batchSpacingMs": 400,
    "batcher.maxBatchesPerTarget": 40,
    "batcher.startBufferMs": 600,
    "batcher.ramStarvationCooldownMs": 750,
    "batcher.useHomeAsWorker": false,
    "batcher.reserveHomeRamGb": 256,
    "batcher.homeScheduleBufferGb": 32,
    "batcher.targetRefreshMs": 15_000,
    "batcher.candidateLimit": 30,
    "batcher.maxTargets": 6,
    "batcher.minTargets": 2,
    "batcher.minTargetRamShareGb": 64,
    "batcher.targetHysteresisKeep": 0.88,
    "batcher.offsets.hack": 0,
    "batcher.offsets.weaken1": 100,
    "batcher.offsets.grow": 200,
    "batcher.offsets.weaken2": 300,
    "batcher.prep.moneyFracMin": 0.95,
    "batcher.prep.secAboveMin": 2.0,
    "batcher.statusEveryMs": 2000,
    "batcher.scripts.hack": "/workers/hack.js",
    "batcher.scripts.grow": "/workers/grow.js",
    "batcher.scripts.weaken": "/workers/weaken.js",
    "batcher.scripts.timedRunner": "/workers/timed-runner.js",
    "batcher.hackFractionPerBatch": 0.1,

    // Targets scoring
    "targets.filters.minAbsoluteMoney": 0,
    "targets.filters.minRelativeMoney": 0,

    // Gangs
    "gangs.loopIntervalMs": 3000,

    // Training thresholds
    "gangs.training.minHackForCrimes": 150,
    "gangs.training.minCombatForCrimes": 150,

    // Wanted management
    "gangs.wanted.minEfficiencyBeforeCleanup": 0.85,  // if eff < 0.90 (10%+ penalty) -> start cleanup
    "gangs.wanted.targetEfficiencyAfterCleanup": 0.95, // keep cleaning until eff > 0.96 (~4% penalty)
    "gangs.wanted.vigilanteFraction": 1.0,

    // Ascension tuning (conservative)
    "gangs.ascension.enableAscension": true,
    "gangs.ascension.minAscendHackMult": 3.0,      // require at least 3x hack multiplier
    "gangs.ascension.minAscendCombatMult": 1.5,    // and 1.5x on all combat stats
    "gangs.ascension.minRespectBeforeAscend": 1000, // don't ascend total scrubs
    "gangs.ascension.gangSafetyRespect": 2_500_000, // avoid ascensions below this respect level
    "gangs.ascension.ascendCooldownMs": 5 * 60 * 1000, // per-member cooldown between ascensions

    // Crime focus: "money" or "respect"
    "gangs.crimeFocus": "money",    // change to "respect" when you want rep-focused crimes
};
