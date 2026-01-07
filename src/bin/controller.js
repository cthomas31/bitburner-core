/** @param {NS} ns **/
export async function main(ns) {
  ns.disableLog("ALL");
  ns.tail();

  const CFG = {
    tickMs: 2000,

    // Your scripts
    scanScore: "bin/scan-score.js",
    targetsFile: "data/targets.json",
    pservManager: "scripts/pserv-manager.js", // requires Formulas.exe
    gangManager: "scripts/gang/manager.js",

    hgwOrchestrator: "scripts/hgw/orchestrator.js",
    batchOrchestrator: "scripts/batch/orchestrator.js", // requires Formulas.exe
    xpDeploy: "scripts/xp/deploy.js",

    // How often to refresh targets.json (scan-score)
    scanEveryMs: 5 * 60 * 1000, // 5 minutes

    // Mode thresholds (tune to taste)
    xpUntilHacking: 250,
    batchFromHacking: 800,

    // Target stickiness: only switch if new target is meaningfully better
    // Example: 1.15 means "new score must be at least +15% better"
    targetSwitchMinImprovement: 1.15,

    // Install policy
    installCooldownMs: 10 * 60 * 1000,
    minPendingAugs: 8,
    minMoneyForInstall: 5e9,
    keepCashBuffer: 200e6,

    // Donation policy
    donateFavorThreshold: 150,
    donateMaxSpendFraction: 0.20,

    factionPriority: [
      "Daedalus",
      "BitRunners",
      "The Black Hand",
      "NiteSec",
      "CyberSec",
      "Sector-12",
      "Aevum",
      "Volhaven",
      "Chongqing",
      "New Tokyo",
      "Ishima",
    ],
  };

  const ctrl = {
    lastInstallTs: 0,
    lastWorkSig: "",
    lastScanTs: 0,

    // Target/mode control
    lastTarget: null,
    lastTargetScore: 0,
    lastMode: null, // "XP" | "HGW" | "BATCH"

    // Singularity “goal”
    currentGoal: "BOOTSTRAP",
    targetFaction: null,
    targetAug: null,
  };

  while (true) {
    const s = snapshot(ns, CFG);
    const formulasAvailable = hasFormulas(ns);

    // Keep managers alive
    ensureIfExists(ns, CFG.pservManager, [], true); // requires Formulas.exe
    ensureIfExists(ns, CFG.gangManager);

    // Refresh targets.json periodically
    if (ns.fileExists(CFG.scanScore, "home")) {
      const now = Date.now();
      if (now - ctrl.lastScanTs > CFG.scanEveryMs && !ns.isRunning(CFG.scanScore, "home")) {
        ns.run(CFG.scanScore, 1);
        ctrl.lastScanTs = now;
      }
    }

    // Decide Singularity goal
    const decision = chooseGoal(ns, CFG, ctrl, s);
    ctrl.currentGoal = decision.goal;
    ctrl.targetFaction = decision.targetFaction ?? null;
    ctrl.targetAug = decision.targetAug ?? null;

    // Decide target + apply stickiness
    const best = pickBestTarget(ns, CFG, s); // {host, score} | null
    const chosen = chooseStickyTarget(ns, CFG, ctrl, s, best);
    const target = chosen?.host ?? "n00dles";

    // Decide mode and run orchestrators accordingly
    const mode = pickMode(CFG, s, target, formulasAvailable);
    applyHackingMode(ns, CFG, ctrl, mode, target);

    // Execute Singularity actions
    await actSingularity(ns, CFG, ctrl, s);

    render(ns, ctrl, s, mode, target, formulasAvailable, best);

    await ns.sleep(CFG.tickMs);
  }
}

/* ---------------- Snapshot ---------------- */

function snapshot(ns, CFG) {
  const player = ns.getPlayer();
  const money = player.money;

  const invitations = ns.singularity.checkFactionInvitations();
  const factions = player.factions ?? [];

  const factionInfo = {};
  for (const f of factions) {
    factionInfo[f] = {
      rep: ns.singularity.getFactionRep(f),
      favor: ns.singularity.getFactionFavor(f),
      canDonate: ns.singularity.getFactionFavor(f) >= CFG.donateFavorThreshold,
    };
  }

  const installedAugs = new Set(ns.singularity.getOwnedAugmentations(true));
  const ownedAugs = new Set(ns.singularity.getOwnedAugmentations(false));
  const pendingAugs = [...ownedAugs].filter(a => !installedAugs.has(a));

  const purchasable = [];
  for (const f of factions) {
    const augs = ns.singularity.getAugmentationsFromFaction(f);
    for (const aug of augs) {
      if (ownedAugs.has(aug)) continue;
      const repReq = ns.singularity.getAugmentationRepReq(aug);
      const price = ns.singularity.getAugmentationPrice(aug);
      purchasable.push({ faction: f, aug, repReq, price });
    }
  }

  const currentWork = ns.singularity.getCurrentWork();
  const programs = new Set(ns.ls("home", ".exe"));

  return {
    player,
    money,
    invitations,
    factions,
    factionInfo,
    installedAugs,
    ownedAugs,
    pendingAugs,
    purchasable,
    currentWork,
    programs,
  };
}

/* ---------------- Script helpers ---------------- */

function hasFormulas(ns) {
  return ns.fileExists("Formulas.exe", "home");
}

function ensureIfExists(ns, script, args = [], requireFormulas = false) {
  if (!ns.fileExists(script, "home")) return;
  if (requireFormulas && !hasFormulas(ns)) return;
  if (ns.isRunning(script, "home", ...args)) return;
  ns.run(script, 1, ...args);
}

function killIfRunning(ns, script) {
  if (!ns.fileExists(script, "home")) return;
  if (ns.isRunning(script, "home")) ns.kill(script, "home");
}

/* ---------------- Targeting ---------------- */

/**
 * Read data/targets.json (array of {host, score, reqHack, maxMoney, ...})
 * and return the best usable target {host, score}.
 */
function pickBestTarget(ns, CFG, s) {
  if (!ns.fileExists(CFG.targetsFile, "home")) return null;

  try {
    const raw = ns.read(CFG.targetsFile);
    if (!raw) return null;

    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) return null;

    const hack = s.player.skills.hacking;

    const usable = rows
      .filter(r => r && typeof r.host === "string")
      .filter(r => ns.serverExists(r.host))
      .filter(r => ns.hasRootAccess(r.host))
      .filter(r => (r.reqHack ?? ns.getServerRequiredHackingLevel(r.host)) <= hack)
      .filter(r => (r.maxMoney ?? ns.getServerMaxMoney(r.host)) > 0)
      .map(r => ({ host: r.host, score: Number(r.score ?? 0) }));

    usable.sort((a, b) => b.score - a.score);
    return usable[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Apply target stickiness:
 * - Keep current target unless it becomes invalid
 * - Switch only if best.score >= current.score * targetSwitchMinImprovement
 */
function chooseStickyTarget(ns, CFG, ctrl, s, best) {
  const current = ctrl.lastTarget;

  // No best target available => keep current if still valid
  if (!best) {
    if (current && isTargetStillValid(ns, s, current)) {
      return { host: current, score: ctrl.lastTargetScore || 0 };
    }
    ctrl.lastTarget = null;
    ctrl.lastTargetScore = 0;
    return null;
  }

  // If we have no current, take best
  if (!current) {
    ctrl.lastTarget = best.host;
    ctrl.lastTargetScore = best.score;
    return best;
  }

  // If current becomes invalid, switch immediately
  if (!isTargetStillValid(ns, s, current)) {
    ctrl.lastTarget = best.host;
    ctrl.lastTargetScore = best.score;
    return best;
  }

  const currentScore = ctrl.lastTargetScore || 0;

  // If score info is missing/zero, behave conservatively: switch to best
  if (currentScore <= 0) {
    ctrl.lastTarget = best.host;
    ctrl.lastTargetScore = best.score;
    return best;
  }

  // If best isn't materially better, keep current
  const threshold = currentScore * CFG.targetSwitchMinImprovement;
  if (best.host !== current && best.score >= threshold) {
    ctrl.lastTarget = best.host;
    ctrl.lastTargetScore = best.score;
    return best;
  }

  // Keep current
  return { host: current, score: currentScore };
}

function isTargetStillValid(ns, s, host) {
  if (!ns.serverExists(host)) return false;
  if (!ns.hasRootAccess(host)) return false;
  if (ns.getServerMaxMoney(host) <= 0) return false;
  if (ns.getServerRequiredHackingLevel(host) > s.player.skills.hacking) return false;
  return true;
}

/* ---------------- Mode selection ---------------- */

function pickMode(CFG, s, target, formulasAvailable) {
  const h = s.player.skills.hacking;

  if (h < CFG.xpUntilHacking) return "XP";
  if (h >= CFG.batchFromHacking) return formulasAvailable ? "BATCH" : "HGW";
  return "HGW";
}

function applyHackingMode(ns, CFG, ctrl, mode, target) {
  const changed = (ctrl.lastMode !== mode) || (ctrl.lastTargetApplied !== target);
  if (!changed) return;

  // Stop competing orchestrators on home
  killIfRunning(ns, CFG.hgwOrchestrator);
  killIfRunning(ns, CFG.batchOrchestrator);
  if (ctrl.lastMode === "XP" || mode === "XP") killIfRunning(ns, CFG.xpDeploy);

  // Start selected mode
  if (mode === "XP") {
    ensureIfExists(ns, CFG.xpDeploy);
  } else if (mode === "HGW") {
    ensureIfExists(ns, CFG.hgwOrchestrator, [target]);
  } else if (mode === "BATCH") {
    ensureIfExists(ns, CFG.batchOrchestrator, [target], true); // requires Formulas.exe
  }

  ctrl.lastMode = mode;
  ctrl.lastTargetApplied = target;
}

/* ---------------- Singularity decisioning ---------------- */

function chooseGoal(ns, CFG, ctrl, s) {
  // 1) Join invites immediately
  if (s.invitations.length > 0) return { goal: "JOIN_FACTIONS" };

  // 2) Daedalus + Red Pill hard-priority
  const hasDaedalus = s.factions.includes("Daedalus");
  const needsRedPill = !s.ownedAugs.has("The Red Pill") && !s.installedAugs.has("The Red Pill");
  if (hasDaedalus && needsRedPill) {
    const rp = s.purchasable.find(x => x.aug === "The Red Pill" && x.faction === "Daedalus");
    if (rp) {
      const haveRep = s.factionInfo["Daedalus"]?.rep ?? 0;
      if (haveRep >= rp.repReq && s.money >= rp.price) {
        return { goal: "BUY_AUGS", targetFaction: "Daedalus", targetAug: "The Red Pill" };
      }
    }
    return { goal: "FARM_REP", targetFaction: "Daedalus", targetAug: "The Red Pill" };
  }

  // 3) Buy augs we can buy now
  const bestBuy = pickBestAffordableAug(ns, CFG, s);
  if (bestBuy) return { goal: "BUY_AUGS", targetFaction: bestBuy.faction, targetAug: bestBuy.aug };

  // 4) Install check
  if (shouldInstall(CFG, ctrl, s)) return { goal: "INSTALL" };

  // 5) Farm rep for best next aug
  const bestRep = pickBestRepTarget(ns, CFG, s);
  if (bestRep) return { goal: "FARM_REP", targetFaction: bestRep.faction, targetAug: bestRep.aug };

  // 6) Idle INT
  return { goal: "IDLE_INT" };
}

function shouldInstall(CFG, ctrl, s) {
  if (s.pendingAugs.length === 0) return false;
  const now = Date.now();
  if (now - ctrl.lastInstallTs < CFG.installCooldownMs) return false;
  if (s.pendingAugs.length >= CFG.minPendingAugs) return true;
  if (s.money >= CFG.minMoneyForInstall) return true;
  return false;
}

function pickBestAffordableAug(ns, CFG, s) {
  const candidates = [];
  for (const x of s.purchasable) {
    const rep = s.factionInfo[x.faction]?.rep ?? 0;
    if (rep < x.repReq) continue;
    if (s.money - CFG.keepCashBuffer < x.price) continue;
    const score = scoreAug(x.aug);
    candidates.push({ ...x, score: score / Math.log10(x.price + 10) });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

function pickBestRepTarget(ns, CFG, s) {
  const candidates = [];
  for (const x of s.purchasable) {
    const rep = s.factionInfo[x.faction]?.rep ?? 0;
    if (rep >= x.repReq) continue;
    const deficit = x.repReq - rep;
    const canDonate = s.factionInfo[x.faction]?.canDonate ?? false;
    const base = scoreAug(x.aug);
    const score = (canDonate ? base * 1.2 : base) / (deficit + 1);
    candidates.push({ ...x, deficit, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] ?? null;
}

// v1 scoring: heuristic by name + Red Pill override
function scoreAug(name) {
  if (name === "The Red Pill") return 1e9;
  let s = 1;
  if (/Neuro|Cranial|Neural|Synaptic|Hack|Data|BitWire/i.test(name)) s += 3;
  if (/Cash|Money|Market|Sales|Business/i.test(name)) s += 1;
  if (/Combat|Blade|Strength|Defense|Dex|Agility/i.test(name)) s += 0.5;
  return s;
}

/* ---------------- Singularity actions ---------------- */

async function actSingularity(ns, CFG, ctrl, s) {
  switch (ctrl.currentGoal) {
    case "JOIN_FACTIONS": {
      for (const f of s.invitations) ns.singularity.joinFaction(f);
      return;
    }

    case "BUY_AUGS": {
      if (ctrl.targetFaction && ctrl.targetAug) {
        ns.singularity.purchaseAugmentation(ctrl.targetFaction, ctrl.targetAug);
      }

      while (true) {
        const ss = snapshot(ns, CFG);
        const best = pickBestAffordableAug(ns, CFG, ss);
        if (!best) break;
        const ok = ns.singularity.purchaseAugmentation(best.faction, best.aug);
        if (!ok) break;
        await ns.sleep(10);
      }
      return;
    }

    case "FARM_REP": {
      const faction = ctrl.targetFaction ?? pickFallbackFaction(CFG, s);
      if (!faction) return;

      const finfo = s.factionInfo[faction];
      if (finfo?.canDonate && ctrl.targetAug && s.money > 1e9) {
        const req = ns.singularity.getAugmentationRepReq(ctrl.targetAug);
        const rep = finfo.rep;
        if (rep < req) {
          const donateAmt = Math.min(s.money * CFG.donateMaxSpendFraction, 5e9);
          ns.singularity.donateToFaction(faction, donateAmt);
          return;
        }
      }

      startFactionWorkDebounced(ns, ctrl, faction, "hacking");
      return;
    }

    case "INSTALL": {
      ctrl.lastInstallTs = Date.now();
      ns.singularity.installAugmentations("bin/bootstrap.js");
      return;
    }

    case "IDLE_INT": {
      const faction = pickFallbackFaction(CFG, s);
      if (!faction) return;
      startFactionWorkDebounced(ns, ctrl, faction, "hacking");
      return;
    }

    default:
      return;
  }
}

function pickFallbackFaction(CFG, s) {
  for (const f of CFG.factionPriority) if (s.factions.includes(f)) return f;
  return s.factions[0] ?? null;
}

function startFactionWorkDebounced(ns, ctrl, faction, workType) {
  const sig = `faction:${faction}:${workType}`;
  if (ctrl.lastWorkSig === sig) return;

  const cw = ns.singularity.getCurrentWork();
  if (cw && cw.type === "FACTION" && cw.factionName === faction && cw.factionWorkType === workType) {
    ctrl.lastWorkSig = sig;
    return;
  }

  const ok = ns.singularity.workForFaction(faction, workType, false);
  if (ok) ctrl.lastWorkSig = sig;
}

/* ---------------- UI ---------------- */

function render(ns, ctrl, s, mode, target, formulasAvailable, best) {
  const lines = [];
  lines.push(
    `Goal: ${ctrl.currentGoal}` +
    (ctrl.targetFaction ? ` | faction=${ctrl.targetFaction}` : "") +
    (ctrl.targetAug ? ` | aug=${ctrl.targetAug}` : "")
  );
  lines.push(`Mode: ${mode} | Target: ${target}`);
  if (best) lines.push(`BestTargetNow: ${best.host} (score=${best.score.toFixed(2)}) | Sticky: ${ctrl.lastTarget} (score=${(ctrl.lastTargetScore || 0).toFixed(2)})`);
  lines.push(`Money: ${fmt(s.money)} | Hack: ${s.player.skills.hacking} | INT: ${s.player.intelligence ?? 0}`);
  lines.push(`Factions: ${s.factions.length} | Invites: ${s.invitations.length} | PendingAugs: ${s.pendingAugs.length}`);
  lines.push(`Formulas.exe: ${formulasAvailable ? "YES" : "NO (batch+pserv disabled)"}`);
  lines.push(`scan-score: ${ns.isRunning("bin/scan-score.js", "home") ? "RUNNING" : "idle"}`);

  const w = s.currentWork ? JSON.stringify(s.currentWork) : "(none)";
  lines.push(`Work: ${w}`);

  ns.clearLog();
  for (const l of lines) ns.print(l);
}

function fmt(n) {
  const a = Math.abs(n);
  if (a >= 1e12) return `${(n / 1e12).toFixed(2)}t`;
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}b`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}m`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(2)}k`;
  return `${n.toFixed(0)}`;
}
