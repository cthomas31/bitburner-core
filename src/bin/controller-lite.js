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

    xpUntilHacking: 250,
    batchFromHacking: 800,
    targetSwitchMinImprovement: 1.15,
  };

  const ctrl = {
    lastScanTs: 0,
    lastMode: null,
    lastTarget: null,
    lastTargetScore: 0,
    lastTargetApplied: null,
  };

  while (true) {
    // keep gang running (no Singularity needed)
    ensure(ns, CFG.gangManager);

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
    applyMode(ns, CFG, ctrl, mode, target, formulas);

    ns.clearLog();
    ns.print(`Mode: ${mode} | Target: ${target}`);
    if (best) ns.print(`BestNow: ${best.host} (${best.score.toFixed(2)}) | Sticky: ${ctrl.lastTarget} (${(ctrl.lastTargetScore||0).toFixed(2)})`);
    ns.print(`Hack: ${hack} | Formulas.exe: ${formulas ? "YES" : "NO"}`);
    ns.print(`scan-score: ${ns.isRunning(CFG.scanScore,"home") ? "RUNNING" : "idle"}`);
    await ns.sleep(CFG.tickMs);
  }
}

function ensure(ns, script, args = []) {
  if (!ns.fileExists(script, "home")) return;
  if (ns.isRunning(script, "home", ...args)) return;
  ns.run(script, 1, ...args);
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
      .filter(r => (r.reqHack ?? ns.getServerRequiredHackingLevel(r.host)) <= hackLevel)
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

function pickMode(CFG, hackLevel, formulas) {
  if (hackLevel < CFG.xpUntilHacking) return "XP";
  if (hackLevel >= CFG.batchFromHacking) return formulas ? "BATCH" : "HGW";
  return "HGW";
}

function applyMode(ns, CFG, ctrl, mode, target, formulas) {
  const changed = ctrl.lastMode !== mode || ctrl.lastTargetApplied !== target;
  if (!changed) return;

  // kill only home-launched orchestrators; your orchestrators manage distribution themselves
  kill(ns, CFG.hgwOrchestrator);
  kill(ns, CFG.batchOrchestrator);
  if (ctrl.lastMode === "XP" || mode === "XP") kill(ns, CFG.xpDeploy);

  if (mode === "XP") {
    ensure(ns, CFG.xpDeploy);
  } else if (mode === "HGW") {
    ensure(ns, CFG.hgwOrchestrator, [target]);
  } else if (mode === "BATCH") {
    if (formulas) ensure(ns, CFG.batchOrchestrator, [target]);
    else ensure(ns, CFG.hgwOrchestrator, [target]);
  }

  ctrl.lastMode = mode;
  ctrl.lastTargetApplied = target;
}

function kill(ns, script) {
  if (ns.fileExists(script, "home") && ns.isRunning(script, "home")) ns.kill(script, "home");
}
