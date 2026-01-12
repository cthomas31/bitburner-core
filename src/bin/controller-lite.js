import { getDarkwebPrograms } from "/scripts/singularity/darkweb-programs.js";

/** @param {NS} ns **/
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();

  const CFG = {
    tickMs: 2000,
    scanScore: "bin/scan-score.js",
    targetsFile: "data/targets.json",
    scanEveryMs: 5 * 60 * 1000,

    hgwOrchestrator: "scripts/hgw/orchestrator.js",
    batchOrchestrator: "scripts/batch/orchestrator.js", // needs Formulas.exe; we'll avoid it
    xpDeploy: "scripts/xp/deploy.js",

    gangManager: "scripts/gang/manager.js",

    xpUntilHacking: 150,
    batchFromHacking: 800,
    targetSwitchMinImprovement: 1.15,
  };

  const ctrl = {
    lastScanTs: 0,
    lastMode: null,
    lastTarget: null,
    lastTargetScore: 0,
    lastTargetApplied: null,
    desired: {mode: null, target: null},
    ensureBackoff: {},
  };

  while (true) {
    // keep gang running (no Singularity needed)
    //ensure(ns, ctrl, CFG.gangManager);

    // refresh targets.json periodically
    const now = Date.now();
    if (ns.fileExists(CFG.scanScore, "home") && now - ctrl.lastScanTs > CFG.scanEveryMs && !ns.isRunning(CFG.scanScore, "home")) {
      ns.run(CFG.scanScore, 1);
      ctrl.lastScanTs = now;
    }

    const hack = ns.getHackingLevel();
    const formulas = ns.fileExists("Formulas.exe", "home");

    const best = pickBestTarget(ns, CFG, hack);
    const chosen = chooseStickyTarget(ns, CFG, ctrl, hack, best);
    const target = chosen?.host ?? "n00dles";

    const mode = pickMode(CFG, hack, formulas);
    setDesired(ns, CFG, ctrl, mode, target, formulas);
    reconcileWorkload(ns, CFG, ctrl);
    ensureDesiredRunning(ns, CFG, ctrl, formulas);


    ns.clearLog();
    ns.print(`Mode: ${mode} | Target: ${target}`);
    if (best) ns.print(`BestNow: ${best.host} (${best.score.toFixed(2)}) | Sticky: ${ctrl.lastTarget} (${(ctrl.lastTargetScore||0).toFixed(2)})`);
    ns.print(`Hack: ${hack} | Formulas.exe: ${formulas ? "YES" : "NO"}`);
    ns.print(`scan-score: ${ns.isRunning(CFG.scanScore,"home") ? "RUNNING" : "idle"}`);
    await ns.sleep(CFG.tickMs);
  }
}

function ensureOnce(ns, ctrl, script, args = [], retryMs = 500) {
  if (!ns.fileExists(script, "home")) return;

  const key = `${script} ${JSON.stringify(args)}`;
  const now = Date.now();

  const nextOk = ctrl.ensureBackoff?.[key] ?? 0;
  if (now < nextOk) return;

  if (ns.isRunning(script, "home", ...args)) {
    // If it's running, clear backoff
    if (ctrl.ensureBackoff) delete ctrl.ensureBackoff[key];
    return;
  }

  const pid = ns.run(script, 1, ...args);
  if (pid === 0) {
    // probably not enough RAM right now; try again soon
    ctrl.ensureBackoff ??= {};
    ctrl.ensureBackoff[key] = now + retryMs;
  } else {
    if (ctrl.ensureBackoff) delete ctrl.ensureBackoff[key];
  }
}

function pickBestTarget(ns, CFG, hackLevel) {
  if (!ns.fileExists(CFG.targetsFile, "home")) return null;
  try {
    const rows = JSON.parse(ns.read(CFG.targetsFile));
    if (!Array.isArray(rows)) return null;
    const usable = rows
      .filter(r => r && typeof r.host === "string")
      .filter(r => ns.serverExists(r.host))
      .filter(r => ns.hasRootAccess(r.host))
      .filter(r => (r.requiredHackingSkill ?? ns.getServerRequiredHackingLevel(r.host)) <= hackLevel)
      .filter(r => (r.maxMoney ?? ns.getServerMaxMoney(r.host)) > 0)
      .map(r => ({ host: r.host, score: Number(r.score ?? 0) }));
    usable.sort((a, b) => b.score - a.score);
    return usable[0] ?? null;
  } catch {
    return null;
  }
}

function chooseStickyTarget(ns, CFG, ctrl, hackLevel, best) {
  const cur = ctrl.lastTarget;

  if (!best) return cur ? { host: cur, score: ctrl.lastTargetScore || 0 } : null;

  if (!cur) {
    ctrl.lastTarget = best.host;
    ctrl.lastTargetScore = best.score;
    return best;
  }

  if (!isValid(ns, cur, hackLevel)) {
    ctrl.lastTarget = best.host;
    ctrl.lastTargetScore = best.score;
    return best;
  }

  const curScore = ctrl.lastTargetScore || 0;
  if (curScore <= 0) {
    ctrl.lastTarget = best.host;
    ctrl.lastTargetScore = best.score;
    return best;
  }

  if (best.host !== cur && best.score >= curScore * CFG.targetSwitchMinImprovement) {
    ctrl.lastTarget = best.host;
    ctrl.lastTargetScore = best.score;
    return best;
  }

  return { host: cur, score: curScore };
}

function isValid(ns, host, hackLevel) {
  return ns.serverExists(host)
    && ns.hasRootAccess(host)
    && ns.getServerMaxMoney(host) > 0
    && ns.getServerRequiredHackingLevel(host) <= hackLevel;
}

function pickMode(CFG, hackLevel, formulas, bestUsable, bestLocked) {
  // Late-game: batch if available
  if (hackLevel >= CFG.batchFromHacking) return formulas ? "BATCH" : "HGW";

  // Default: money mode (HGW)
  let mode = "HGW";

  // Opportunistic XP: only if it unlocks a meaningfully better target soon
  if (bestLocked) {
    const delta = bestLocked.reqHack - hackLevel;
    const unlockSoon = delta <= CFG.xpUnlockWindowLevels; // e.g. 50
    const currentScore = bestUsable?.score ?? 0;
    const lockedScore = bestLocked.score ?? 0;

    // "Meaningfully better": e.g. >= 1.25x better score
    const betterEnough =
      currentScore <= 0 ? true : (lockedScore >= currentScore * CFG.xpUnlockMinImprovement);

    if (unlockSoon && betterEnough) mode = "XP";
  }

  return mode;
}

function applyMode(ns, CFG, ctrl, mode, target, formulas) {
  const changed = ctrl.lastMode !== mode || ctrl.lastTargetApplied !== target;
  if (!changed) return;

  // kill only home-launched orchestrators; your orchestrators manage distribution themselves
  kill(ns, CFG.hgwOrchestrator);
  kill(ns, CFG.batchOrchestrator);
  if (ctrl.lastMode === "XP" || mode === "XP") kill(ns, CFG.xpDeploy);

  if (mode === "XP") {
    ensureOnce(ns, ctrl, CFG.xpDeploy);
  } else if (mode === "HGW") {
    ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [target]);
  } else if (mode === "BATCH") {
    if (formulas) {
      ensureOnce(ns, ctrl, CFG.batchOrchestrator, [target]);
    } else {
      ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [target]);
    }
  }

  ctrl.lastMode = mode;
  ctrl.lastTargetApplied = target;
}

function setDesired(ns, CFG, ctrl, mode, target, formulas) {
  // If batch requested but formulas missing, degrade to HGW
  if (mode === "BATCH" && !formulas) mode = "HGW";

  ctrl.desired = { mode, target };
}

function reconcileWorkload(ns, CFG, ctrl) {
  const d = ctrl.desired;
  const c = ctrl.current ?? { mode: null, target: null };

  const changed = c.mode !== d.mode || c.target !== d.target;
  if (!changed) return;

  // Something about the desired workload changed → stop old orchestrators
  kill(ns, CFG.hgwOrchestrator);
  kill(ns, CFG.batchOrchestrator);
  kill(ns, CFG.xpDeploy);

  // Update current to desired; actual start happens in ensureDesiredRunning()
  ctrl.current = { ...d };

  // Clear backoff so we retry immediately after reconfigure
  ctrl.ensureBackoff = {};
}

function ensureDesiredRunning(ns, CFG, ctrl, formulas) {
  const d = ctrl.desired;
  if (!d?.mode) return;

  if (d.mode === "XP") {
    ensureOnce(ns, ctrl, CFG.xpDeploy);
    return;
  }

  if (d.mode === "HGW") {
    ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [d.target]);
    return;
  }

  if (d.mode === "BATCH") {
    if (formulas) ensureOnce(ns, ctrl, CFG.batchOrchestrator, [d.target]);
    else ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [d.target]);
    return;
  }
}

function kill(ns, script) {
  if (ns.fileExists(script, "home") && ns.isRunning(script, "home")) ns.kill(script, "home");
}
