import type { NS } from "@ns";
import { makeSettingsWatcher, reloadSettings } from "/lib/settings.js";
import { checkFactionServers } from "/app/hacking/check-faction-servers.js";
import { getDarkwebPrograms } from "/app/hacking/darkweb-programs.js";
import {
    ControllerConfig,
    ControllerState,
    DataPaths,
} from "/domain/controller/types.js";
import { getControllerConfig } from "/domain/controller/config.js";
import { makeStockManager, StockManager } from "/app/stocks/manager.js";
import { getStockManagerConfig } from "/domain/stocks/config.js";
import { drawUI } from "/domain/controller/ui.js";
import {
    pickMoneyFirstMode,
    reconcileWorkload,
    ensureDesiredRunning,
    ensureOnce,
} from "/domain/controller/workload.js";
import { trySyscall } from "/domain/controller/syscalls.js";
import {
    pickBestTarget,
    chooseStickyTarget,
} from "/domain/controller/targeting.js";
import {
    applyFactionCacheFromFiles,
    maybeStartFactionCacheUpdate,
} from "/domain/controller/factions.js";
import {
    applyAugFactsFromFiles,
    applyOwnedAugsFromFiles,
    tickAugs,
} from "/domain/controller/augs_automation.js";
import {
    applyFactionRepFromFile,
    tickFactions,
} from "/domain/controller/factions_automation.js";

// ============== Main Entry Point ==============

export async function main(ns: NS): Promise<void> {
    ns.disableLog("ALL");
    ns.ui.openTail();

    // Refresh settings cache on controller start
    reloadSettings(ns);

    const CFG: ControllerConfig = getControllerConfig(ns);

    const dataPath: DataPaths = {
        owned: `${CFG.data_dir}/owned-augs.json`,
        owned_purchased: `${CFG.data_dir}/owned-augs-purchased.json`,
        invites: `${CFG.data_dir}/invites.json`,
        joinOut: `${CFG.data_dir}/join-faction.json`,

        augsFaction: `${CFG.data_dir}/augs-from-faction.json`,
        factionRep: `${CFG.data_dir}/faction-rep.json`,

        augPrice: `${CFG.data_dir}/aug-price.json`,
        augRep: `${CFG.data_dir}/aug-rep.json`,
        augStats: `${CFG.data_dir}/aug-stats.json`,
        augReqs: `${CFG.data_dir}/aug-prereqs.json`,

        buy: `${CFG.data_dir}/purchase-aug.json`,

        install: `${CFG.data_dir}/install.json`,
        work: `${CFG.data_dir}/work-faction.json`,
    };

    const ctrl: ControllerState = {
        lastScanTs: 0,
        lastMode: null,
        lastTarget: null,
        lastTargetScore: 0,
        lastTargetApplied: null,

        // syscall scheduling
        syscallPid: 0,
        syscallKey: null,

        lastDarkwebCheckTs: 0,
        lastFactionServersCheckTs: 0,
        lastJoinInvitesTs: 0,
        lastOwnedAugsTs: 0,
        lastInstallTs: 0,
        lastWorkFactionTs: 0,
        lastAugsFromFactionTs: 0,
        lastFactionRepTs: 0,

        lastAugProbeTs: 0,
        lastAugStatsTs: 0,
        lastAugPrereqTs: 0,
        lastAugBuyTs: 0,

        // cached state
        pendingAugsCount: 0,
        chosenFaction: null,
        factionRep: 0,

        invites: [],

        augsFromFaction: [],
        augCandidates: [],

        // augFacts[aug] = { price?, repReq?, stats?, prereqs? }
        augFacts: {},

        // Faction caches for smarter choosing
        // factionRepCache[f]  = { rep, ts }
        // factionAugsCache[f] = { augs: [...], ts }
        factionRepCache: {},
        factionAugsCache: {},
        factionCacheIndex: 0,
        lastFactionCacheUpdateTs: 0,

        // pendingPurchase = { faction, aug }
        pendingPurchase: null,

        ensureBackoff: {},

        statusMessages: [],
    };

    const stockMgr: StockManager = makeStockManager(getStockManagerConfig(ns));
    await stockMgr.init(ns, ctrl);

    // Ensure results dir exists (write a noop file)
    ns.write(`${CFG.data_dir}/keep.json`, "ok", "w");

    const maybeReloadSettings = makeSettingsWatcher(ns, "/settings.json", 2000);

    for (;;) {
        const now = Date.now();

        // Refresh settings if changed
        const reloadStatus = maybeReloadSettings();
        if (reloadStatus) {
            ctrl.statusMessages.push(
                new Date(now).toLocaleString() + ": " + reloadStatus
            );
        }

        const hack = ns.getHackingLevel();
        const formulas = ns.fileExists("Formulas.exe", "home");

        // ---- Hacking workload ----
        const best = await pickBestTarget(ns, CFG, hack);
        const chosen = chooseStickyTarget(ns, CFG, ctrl, hack, best);
        const target = chosen?.host ?? "n00dles";
        const mode = pickMoneyFirstMode(hack, CFG.batchFromHacking, formulas);

        tick: {
            await stockMgr.tick(ns, ctrl, now);

            // Keep gang manager alive
            if (CFG.enableGangManager) {
                ensureOnce(ns, ctrl, CFG.gangManager);
            }

            // Keep pserv manager alive
            if (CFG.enablePservManager) {
                ensureOnce(ns, ctrl, CFG.pservManager);
            }

            // Refresh targets.json periodically (but don't let scan-score starve syscall starts)
            const syscallBackoffActive = Object.entries(
                ctrl.ensureBackoff
            ).some(([k, t]) => k.startsWith("syscall:") && Date.now() < t);

            if (
                !syscallBackoffActive &&
                ns.fileExists(CFG.scanScore, "home") &&
                now - ctrl.lastScanTs > CFG.scanEveryMs &&
                !ns.isRunning(CFG.scanScore, "home")
            ) {
                ns.run(CFG.scanScore, 1);
                ctrl.lastScanTs = now;
            }

            // Hacking workload
            reconcileWorkload(ns, CFG, ctrl, mode, target);
            ensureDesiredRunning(ns, CFG, ctrl, mode, target, formulas);

            // ---- Singularity syscalls (one at a time) ----
            if (ctrl.syscallPid !== 0 && ns.isRunning(ctrl.syscallPid)) {
                // still running
            } else {
                ctrl.syscallPid = 0;

                // Apply results from previous probes (cheap reads)
                await applyFactionCacheFromFiles(ns, ctrl, dataPath);
                await applyFactionRepFromFile(ns, ctrl, dataPath);
                await applyAugFactsFromFiles(ns, ctrl, dataPath);
                if (CFG.enableAugs || CFG.enableFactions) {
                    await applyOwnedAugsFromFiles(ns, ctrl, dataPath);
                }

                // Background cache upkeep: periodically refresh 1 faction (rep or aug list)
                // so smart chooser has data. This is intentionally gentle.
                if (CFG.enableFactions) {
                    const pid = maybeStartFactionCacheUpdate(
                        ns,
                        CFG,
                        ctrl,
                        now,
                        dataPath
                    );
                    if (pid !== 0) {
                        ctrl.syscallPid = pid;
                        // syscallKey is set inside helper
                        // IMPORTANT: break tick so the single drawUI call runs and we don't start other syscalls
                        break tick;
                    }
                }

                // Darkweb syscalls
                if (CFG.enableDarkwebChecks && now - ctrl.lastDarkwebCheckTs > CFG.checkDarkwebEveryMs) {
                    if (!ns.hasTorRouter()) {
                        const key = "syscall:tor";
                        const pid = trySyscall(
                            ns,
                            ctrl,
                            key,
                            "scripts/singularity/purchase-tor.js",
                            [],
                            1000
                        );
                        if (pid !== 0) {
                            ctrl.syscallPid = pid;
                            ctrl.syscallKey = key;
                        }
                    } else {
                        await getDarkwebPrograms(ns);
                    }
                    ctrl.lastDarkwebCheckTs = now;
                    // ctrl.statusMessages.push(
                    //     new Date(ctrl.lastDarkwebCheckTs).toLocaleString() +
                    //         ": Checked darkweb programs"
                    // );
                    break tick;
                }

                // Faction servers syscall
                if (
                    CFG.enableCheckFactionServers &&
                    now - ctrl.lastFactionServersCheckTs >
                    CFG.checkFactionServersEveryMs
                ) {
                    await checkFactionServers(ns);
                    ctrl.lastFactionServersCheckTs = now;
                    ctrl.statusMessages.push(
                        new Date(
                            ctrl.lastFactionServersCheckTs
                        ).toLocaleString() + ": Checked faction servers"
                    );
                    break tick;
                }

                // When faction automation is disabled, keep chosenFaction null so aug pipeline no-ops cleanly.
                if (!CFG.enableFactions) {
                    ctrl.chosenFaction = null;
                }

                if (CFG.enableFactions) {
                    const factionResult = await tickFactions(
                        ns,
                        CFG,
                        ctrl,
                        now,
                        dataPath
                    );
                    if (factionResult === "started_syscall") break tick;
                }

                if (CFG.enableAugs) {
                    const augResult = await tickAugs(ns, CFG, ctrl, now, dataPath, {
                        factionsEnabled: CFG.enableFactions,
                    });
                    if (augResult === "started_syscall") break tick;
                } else {
                    ctrl.pendingPurchase = null;
                }
            }
        }
        const stockLines = stockMgr.status(ctrl);
        await drawUI(
            ns,
            CFG,
            ctrl,
            best,
            mode,
            target,
            hack,
            formulas,
            stockLines
        );
        await ns.sleep(CFG.tickMs);
    }
}
