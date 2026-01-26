import type { NS } from "@ns";
import {
    getBool,
    getNumber,
    getString,
    getStringArray,
} from "/lib/settings.js";
import type {
    ControllerConfig,
    FactionChooserConfig,
} from "/domain/controller/types.js";

export function getControllerConfig(ns: NS): ControllerConfig {
    const chooser: FactionChooserConfig = {
        repCacheMs: getNumber(ns, "controller.factions.chooser.repCacheMs"),
        augsCacheMs: getNumber(ns, "controller.factions.chooser.augsCacheMs"),
        repGapPenalty: getNumber(
            ns,
            "controller.factions.chooser.repGapPenalty"
        ),
        buyNowBonus: getNumber(ns, "controller.factions.chooser.buyNowBonus"),
        crossFactionPrereqPenalty: getNumber(
            ns,
            "controller.factions.chooser.crossFactionPrereqPenalty"
        ),
    };

    return {
        tickMs: getNumber(ns, "controller.tickMs"),

        scanScore: getString(ns, "controller.scripts.scanScore"),
        targetsFile: getString(ns, "paths.targetsFile"),
        scanEveryMs: getNumber(ns, "controller.scanEveryMs"),

        hgwOrchestrator: getString(ns, "controller.scripts.hgwOrchestrator"),
        batchOrchestrator: getString(
            ns,
            "controller.scripts.batchOrchestrator"
        ),
        xpDeploy: getString(ns, "controller.scripts.xpDeploy"),
        gangManager: getString(ns, "controller.scripts.gangManager"),
        pservManager: getString(ns, "controller.scripts.pservManager"),
        hackingWorkloadMode: getString(ns, "controller.hacking.workloadMode") as
            | "AUTO"
            | "MONEY"
            | "XP",

        enableGangManager: getBool(ns, "controller.flags.enableGangManager"),
        enablePservManager: getBool(ns, "controller.flags.enablePservManager"),
        enableDarkwebChecks: getBool(
            ns,
            "controller.flags.enableDarkwebChecks"
        ),
        enableCheckFactionServers: getBool(
            ns,
            "controller.flags.enableCheckFactionServers"
        ),
        enableAugs: getBool(ns, "controller.augs.enable"),
        enableFactions: getBool(ns, "controller.factions.enable"),

        batchFromHacking: getNumber(ns, "controller.hacking.batchFromHacking"),
        targetSwitchMinImprovement: getNumber(
            ns,
            "controller.targets.switchMinImprovement"
        ),

        data_dir: getString(ns, "controller.paths.singularityDir"),

        checkDarkwebEveryMs: getNumber(
            ns,
            "controller.syscalls.darkweb.everyMs"
        ),
        checkFactionServersEveryMs: getNumber(
            ns,
            "controller.syscalls.factionServers.everyMs"
        ),
        joinInvitesEveryMs: getNumber(
            ns,
            "controller.syscalls.factions.joinInvitesEveryMs"
        ),
        workFactionEveryMs: getNumber(
            ns,
            "controller.syscalls.factions.workEveryMs"
        ),
        ownedAugsEveryMs: getNumber(
            ns,
            "controller.syscalls.augs.ownedEveryMs"
        ),
        augsFromFactionEveryMs: getNumber(
            ns,
            "controller.syscalls.augs.fromFactionEveryMs"
        ),
        factionRepEveryMs: getNumber(ns, "controller.syscalls.augs.repEveryMs"),
        augProbeEveryMs: getNumber(ns, "controller.syscalls.augs.probeEveryMs"),
        augStatsEveryMs: getNumber(ns, "controller.syscalls.augs.statsEveryMs"),
        augPrereqEveryMs: getNumber(
            ns,
            "controller.syscalls.augs.prereqsEveryMs"
        ),
        augBuyCooldownMs: getNumber(
            ns,
            "controller.syscalls.augs.buyCooldownMs"
        ),

        repReachBuffer: getNumber(ns, "controller.augs.buy.repReachBuffer"),
        maxAugSpendFraction: getNumber(
            ns,
            "controller.augs.buy.maxSpendFraction"
        ),
        minCashReserve: getNumber(ns, "controller.augs.buy.minCashReserve"),

        maxAugFactsCache: getNumber(ns, "controller.augs.cache.maxFacts"),

        factionPriority: getStringArray(ns, "controller.factions.priority"),
        factionWorkType: getString(ns, "controller.factions.workType"),
        factionChooser: chooser,

        installCooldownMs: getNumber(ns, "controller.augs.install.cooldownMs"),
        minPendingAugs: getNumber(ns, "controller.augs.install.minPending"),

        enableDonations: getBool(ns, "controller.factions.enableDonations"),
    };
}

export type { ControllerConfig } from "/domain/controller/types.js";
