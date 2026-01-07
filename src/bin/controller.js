import { writeJSON, readJSON } from "/lib/ns-io";

/** @param {NS} ns **/
export async function main(ns) {
  ns.disableLog("ALL");
  ns.enableLog("run");
  ns.tail();

  const CFG = {
    tickMs: 2000,

    // ---- Your existing stuff ----
    scanScore: "bin/scan-score.js",
    targetsFile: "data/targets.json",
    scanEveryMs: 5 * 60 * 1000,

    hgwOrchestrator: "scripts/hgw/orchestrator.js",
    batchOrchestrator: "scripts/batch/orchestrator.js",
    xpDeploy: "scripts/xp/deploy.js",
    gangManager: "scripts/gang/manager.js",

    batchFromHacking: 800,
    targetSwitchMinImprovement: 1.15,

    // ---- Singularity syscalls ----
    singDir: "data/singularity",
    joinInvitesEveryMs: 60 * 1000,
    ownedAugsEveryMs: 60 * 1000,

    // Rep grind (pick one faction)
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
    factionWorkType: "hacking", // good default for BN5

    // Install policy (simple, safe)
    installCooldownMs: 10 * 60 * 1000,
    minPendingAugs: 8,

    // Donations: optional toggle (requires your favor logic elsewhere; leaving OFF by default)
    enableDonations: false,

    // Aug pipeline scheduling
    augsFromFactionEveryMs: 5 * 60 * 1000,
    factionRepEveryMs: 30 * 1000,
    augProbeEveryMs: 2000,          // how often to probe price/rep (one probe per tick-ish)
    augBuyCooldownMs: 3000,         // don’t spam buys
    maxAugSpendFraction: 0.25,      // don’t spend more than 25% of cash on one aug
    minCashReserve: 5e8,            // keep at least $500m (tune)
  };

  const ctrl = {
    lastScanTs: 0,
    lastMode: null,
    lastTarget: null,
    lastTargetScore: 0,
    lastTargetApplied: null,

    // syscall scheduling
    syscallPid: 0,
    lastJoinInvitesTs: 0,
    lastOwnedAugsTs: 0,
    lastInstallTs: 0,

    // cached state from syscall results
    pendingAugsCount: 0,
    chosenFaction: null,

    ensureBackoff: {},
    statusMessages: [],

    invites: [],
    lastInvitesReadTs: 0,
    lastInviteCheckTs: 0,

    lastAugsFromFactionTs: 0,
    lastFactionRepTs: 0,
    lastAugProbeTs: 0,
    lastAugBuyTs: 0,

    factionRep: 0,

    augsFromFaction: [],            // cached list
    augCandidates: [],              // to probe price/rep
    augFacts: {},                   // augName -> { price?, repReq?, tsPrice?, tsRep? }
    pendingPurchase: null,          // { faction, aug }

  };

  // Ensure results dir exists (write a noop file)
  ns.write(`${CFG.singDir}/keep.json`, "ok", "w");

  while (true) {
    const now = Date.now();
    const hack = ns.getHackingLevel();
    const formulas = ns.fileExists("Formulas.exe", "home");

    // Keep gang manager alive
    ensureOnce(ns, ctrl, CFG.gangManager);

    // Refresh targets.json periodically but only if a syscall isn't active
    const syscallBackoffActive = Object.entries(ctrl.ensureBackoff)
      .some(([k, t]) => k.startsWith("syscall:") && Date.now() < t);

    if (!syscallBackoffActive &&
      ns.fileExists(CFG.scanScore, "home") &&
      now - ctrl.lastScanTs > CFG.scanEveryMs &&
      !ns.isRunning(CFG.scanScore, "home")) {
      ns.run(CFG.scanScore, 1);
      ctrl.lastScanTs = now;
    }

    // ---- Hacking workload (use your existing target picking + stickiness) ----
    const best = pickBestTarget(ns, CFG, hack);
    const chosen = chooseStickyTarget(ns, CFG, ctrl, hack, best);
    const target = chosen?.host ?? "n00dles";
    const mode = pickMoneyFirstMode(hack, formulas);

    // Reconcile (kill wrong) only when identity changes
    reconcileWorkload(ns, CFG, ctrl, mode, target);
    // Ensure desired is running every tick (retries if scan-score temporarily blocks RAM)
    ensureDesiredRunning(ns, CFG, ctrl, mode, target, formulas);

    // ---- Singularity: run at most one syscall at a time ----
    if (ctrl.syscallPid !== 0 && ns.isRunning(ctrl.syscallPid)) {
      // still running
    } else {
      ctrl.syscallPid = 0;

      const P = {
        owned: `${CFG.singDir}/owned-augs.json`,
        augsFaction: `${CFG.singDir}/augs-from-faction.json`,
        factionRep: `${CFG.singDir}/faction-rep.json`,
        augPrice: `${CFG.singDir}/aug-price.json`,
        augRep: `${CFG.singDir}/aug-rep.json`,
        buy: `${CFG.singDir}/purchase-aug.json`,
      };

      if (ctrl.syscallPid === 0 &&
        ctrl.chosenFaction &&
        (now - ctrl.lastFactionRepTs > CFG.factionRepEveryMs)) {

        const pid = trySyscall(
          ns, ctrl,
          "syscall:factionRep",
          "scripts/singularity/get-faction-rep.js",
          [ctrl.chosenFaction, P.factionRep],
          1000
        );
        if (pid !== 0) {
          ctrl.syscallPid = pid;
          ctrl.lastFactionRepTs = now;
        }
      }

      const repObj = readJSON(ns, P.factionRep);
      if (repObj?.ok && repObj?.faction === ctrl.chosenFaction) {
        ctrl.factionRep = Number(repObj.rep ?? ctrl.factionRep ?? 0);
      }

      // Refresh cached owned/pending count (controller-side read)
      ctrl.pendingAugsCount = readPendingCount(ns, P.owned, ctrl.pendingAugsCount);
      const ownedObj = readJSON(ns, P.owned);
      const ownedList = Array.isArray(ownedObj?.owned) ? ownedObj.owned : [];
      const ownedSet = new Set(ownedList);

      // Choose faction to focus (you already do this)
      ctrl.chosenFaction = pickFactionToWork(ns, CFG);

      // Refresh "augs from faction" occasionally
      if (ctrl.syscallPid === 0 &&
        ctrl.chosenFaction &&
        (now - ctrl.lastAugsFromFactionTs > CFG.augsFromFactionEveryMs)) {

        const pid = trySyscall(
          ns, ctrl,
          "syscall:augsFromFaction",
          "scripts/singularity/get-augs-from-faction.js",
          [ctrl.chosenFaction, P.augsFaction],
          1000
        );
        if (pid !== 0) {
          ctrl.syscallPid = pid;
          ctrl.lastAugsFromFactionTs = now; // only if pid != 0
        }
      }

      // Update cached augsFromFaction list (controller-side read)
      const augsObj = readJSON(ns, P.augsFaction);
      if (augsObj?.ok && augsObj?.faction === ctrl.chosenFaction && Array.isArray(augsObj?.augs)) {
        ctrl.augsFromFaction = augsObj.augs.slice();
        // rebuild candidate list: those not owned
        ctrl.augCandidates = ctrl.augsFromFaction.filter(a => !ownedSet.has(a));
      }

      // If we have a pending purchase, attempt it (80GB syscall)
      if (ctrl.syscallPid === 0 &&
        ctrl.pendingPurchase &&
        (now - ctrl.lastAugBuyTs > CFG.augBuyCooldownMs)) {

        const { faction, aug } = ctrl.pendingPurchase;
        const pid = trySyscall(
          ns, ctrl,
          "syscall:purchaseAug",
          "scripts/singularity/purchase-aug.js",
          [faction, aug, P.buy],
          1500
        );
        if (pid !== 0) {
          ctrl.syscallPid = pid;
          ctrl.lastAugBuyTs = now;
          ctrl.pendingPurchase = null; // optimistic; we’ll re-evaluate next tick
        }
      }

      // Otherwise probe facts for one candidate (40GB syscalls)
      if (ctrl.syscallPid === 0 &&
        (now - ctrl.lastAugProbeTs > CFG.augProbeEveryMs) &&
        ctrl.augCandidates?.length) {

        // pick first candidate missing facts
        const aug = ctrl.augCandidates.find(a => !haveAugFacts(ctrl, a));
        if (aug) {
          ctrl.augFacts ??= {};
          ctrl.augFacts[aug] ??= {};

          // alternate price/rep probes to avoid doing both in same tick
          const f = ctrl.augFacts[aug];
          const needPrice = !Number.isFinite(f.price);
          const needRep = !Number.isFinite(f.repReq);

          let pid = 0;
          if (needPrice) {
            pid = trySyscall(ns, ctrl, `syscall:price:${aug}`, "scripts/singularity/get-aug-price.js", [aug, P.augPrice], 1000);
          } else if (needRep) {
            pid = trySyscall(ns, ctrl, `syscall:rep:${aug}`, "scripts/singularity/get-aug-rep.js", [aug, P.augRep], 1000);
          }

          if (pid !== 0) {
            ctrl.syscallPid = pid;
            ctrl.lastAugProbeTs = now;
          }
        } else {
          // all facts known → decide what to buy
          const cash = ns.getPlayer().money;
          const spendCap = Math.max(0, cash * CFG.maxAugSpendFraction);
          const reserve = CFG.minCashReserve;

          // Build purchasable list (by facts only; rep check comes later if you add getFactionRep)
          const known = ctrl.augCandidates
            .filter(a => haveAugFacts(ctrl, a))
            .map(a => ({ aug: a, price: ctrl.augFacts[a].price, repReq: ctrl.augFacts[a].repReq }))
            .sort((a, b) => a.price - b.price);

          // We can’t check actual faction rep without a separate 16GB syscall (getFactionRep),
          // so for now we buy only when you *know* you have rep (or you add that syscall next).
          // Practical hack: buy the cheapest ones first after some grinding time, and let purchase fail if no rep.
          const choice = known.find(x => x.price <= spendCap && (cash - x.price) >= reserve);

          if (choice && ctrl.chosenFaction) {
            ctrl.pendingPurchase = { faction: ctrl.chosenFaction, aug: choice.aug };
          }
        }
      }

      // Apply results of last probes (controller-side read)
      const priceObj = readJSON(ns, P.augPrice);
      if (priceObj?.ok && priceObj?.aug) {
        ctrl.augFacts ??= {};
        ctrl.augFacts[priceObj.aug] ??= {};
        ctrl.augFacts[priceObj.aug].price = clampNumber(priceObj.price, undefined);
      }

      const repObj = readJSON(ns, P.augRep);
      if (repObj?.ok && repObj?.aug) {
        ctrl.augFacts ??= {};
        ctrl.augFacts[repObj.aug] ??= {};
        ctrl.augFacts[repObj.aug].repReq = clampNumber(repObj.repReq, undefined);
      }

      // Load invites list occasionally (controller-side, no Singularity)
      ctrl.invites = readInvites(ns, `${CFG.singDir}/invites.json`, ctrl.invites);

      const nextFaction = ctrl.invites?.[0];
      if (nextFaction) {
        const pid = trySyscall(
          ns, ctrl,
          "syscall:joinFaction",
          "scripts/singularity/join-faction.js",
          [nextFaction, `${CFG.singDir}/join-faction.json`],
          1000
        );
        if (pid !== 0) {
          ctrl.syscallPid = pid;
          // optimistic: pop it so we don't spam the same faction
          ctrl.invites.shift();
          // persist trimmed list so restart doesn't redo
          await writeJSON(ns, `${CFG.singDir}/invites.json`, { ts: Date.now(), invites: ctrl.invites });
        }
      } else {
        // fallback: work for faction like before
        ctrl.chosenFaction = pickFactionToWork(ns, CFG);
        if (ctrl.chosenFaction) {
          const pid = trySyscall(
            ns, ctrl,
            "syscall:workFaction",
            "scripts/singularity/work-faction.js",
            [ctrl.chosenFaction, CFG.factionWorkType, false, `${CFG.singDir}/work-faction.json`],
            1000
          );
          if (pid !== 0) ctrl.syscallPid = pid;
        }
      }

      // 1) join invites periodically
      if (now - ctrl.lastJoinInvitesTs > CFG.joinInvitesEveryMs) {
        const pid = trySyscall(
          ns, ctrl,
          "syscall:checkInvites",
          "scripts/singularity/check-invites.js",
          [`${CFG.singDir}/invites.json`],
          1000
        );
        if (pid !== 0) {
          ctrl.syscallPid = pid;
          ctrl.lastJoinInvitesTs = now; // only on success
        }
      }

      // 2) refresh pending aug count periodically
      else if (now - ctrl.lastOwnedAugsTs > CFG.ownedAugsEveryMs) {
        const pid = trySyscall(
          ns, ctrl,
          "syscall:ownedAugs",
          "scripts/singularity/get-owned-augs.js",
          [`${CFG.singDir}/owned-augs.json`],
          1000
        );
        if (pid !== 0) {
          ctrl.syscallPid = pid;
          ctrl.lastOwnedAugsTs = now; // only on success
        }
        else logSyscallFailure(ns, ctrl, "get-owned-augs.js");
      }

      // 3) work for faction (keep trying if we have one)
      else {
        ctrl.chosenFaction = pickFactionToWork(ns, CFG);
        if (ctrl.chosenFaction) {
          const pid = trySyscall(
            ns, ctrl,
            "syscall:workFaction",
            "scripts/singularity/work-faction.js",
            [ctrl.chosenFaction, CFG.factionWorkType, false, `${CFG.singDir}/work-faction.json`],
            1000
          );
          if (pid !== 0) {
            ctrl.syscallPid = pid
          } else logSyscallFailure(ns, ctrl, "work-faction.js");
        }
      }

      // 4) install (only if no other syscall launched)
      ctrl.pendingAugsCount = readPendingCount(ns, `${CFG.singDir}/owned-augs.json`, ctrl.pendingAugsCount);

      const canInstall =
        ctrl.pendingAugsCount >= CFG.minPendingAugs &&
        (now - ctrl.lastInstallTs) > CFG.installCooldownMs;

      if (canInstall && ctrl.syscallPid === 0) {
        const pid = trySyscall(
          ns, ctrl,
          "syscall:install",
          "scripts/singularity/install.js",
          ["bootstrap.js", `${CFG.singDir}/install.json`],
          2000
        );
        if (pid !== 0) {
          ctrl.syscallPid = pid;
          ctrl.lastInstallTs = now; // only on success
        }
        else logSyscallFailure(ns, ctrl, "install.js");
      }
    }


    // ---- UI ----
    ns.clearLog();
    ns.print(`Mode: ${mode} | Target: ${target}`);
    if (best) ns.print(`BestNow: ${best.host} (${best.score.toFixed(2)}) | Sticky: ${ctrl.lastTarget} (${(ctrl.lastTargetScore || 0).toFixed(2)})`);
    ns.print(`Hack: ${hack} | Formulas.exe: ${formulas ? "YES" : "NO"}`);
    ns.print(`PendingAugs: ${ctrl.pendingAugsCount} | InstallCooldown: ${Math.max(0, Math.floor((CFG.installCooldownMs - (now - ctrl.lastInstallTs)) / 1000))}s`);
    ns.print(`FactionWork: ${ctrl.chosenFaction ?? "(none)"}`);
    ns.print(`Syscall: ${ctrl.syscallPid ? `PID ${ctrl.syscallPid}` : "idle"}`);
    ns.print(`scan-score: ${ns.isRunning(CFG.scanScore, "home") ? "RUNNING" : "idle"}`);
    for (const msg of ctrl.statusMessages) ns.print(`* ${msg}`);

    await ns.sleep(CFG.tickMs);
  }
}

function freeRam(ns, host = "home") {
  return ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
}

function logSyscallFailure(ns, ctrl, script) {
  const free = freeRam(ns, "home");
  const message = `Syscall failed (${script}) freeRam=${free.toFixed(1)}GB`;
  ctrl.statusMessages.push(message);
}

/* ---------------- Workload logic ---------------- */

function pickMoneyFirstMode(hackLevel, formulas) {
  // cash-first: HGW until batching becomes worthwhile
  if (hackLevel >= 800) return formulas ? "BATCH" : "HGW";
  return "HGW";
}

function reconcileWorkload(ns, CFG, ctrl, mode, target) {
  const changed = (ctrl.lastMode !== mode) || (ctrl.lastTargetApplied !== target);
  if (!changed) return;

  kill(ns, CFG.hgwOrchestrator);
  kill(ns, CFG.batchOrchestrator);
  kill(ns, CFG.xpDeploy);

  ctrl.lastMode = mode;
  ctrl.lastTargetApplied = target;

  // Clear ensure backoff so we retry immediately
  ctrl.ensureBackoff = {};
}

function ensureDesiredRunning(ns, CFG, ctrl, mode, target, formulas) {
  if (mode === "HGW") {
    ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [target]);
  } else if (mode === "BATCH") {
    if (formulas) ensureOnce(ns, ctrl, CFG.batchOrchestrator, [target]);
    else ensureOnce(ns, ctrl, CFG.hgwOrchestrator, [target]);
  } else if (mode === "XP") {
    ensureOnce(ns, ctrl, CFG.xpDeploy);
  }
}

function ensureOnce(ns, ctrl, script, args = [], retryMs = 500) {
  if (!ns.fileExists(script, "home")) return;

  const key = `${script} ${JSON.stringify(args)}`;
  const now = Date.now();
  const nextOk = ctrl.ensureBackoff?.[key] ?? 0;
  if (now < nextOk) return;

  if (ns.isRunning(script, "home", ...args)) {
    delete ctrl.ensureBackoff[key];
    return;
  }

  const pid = ns.run(script, 1, ...args);
  if (pid === 0) {
    ctrl.ensureBackoff[key] = now + retryMs;
  } else {
    delete ctrl.ensureBackoff[key];
  }
}

function kill(ns, script) {
  if (ns.fileExists(script, "home") && ns.isRunning(script, "home")) ns.kill(script, "home");
}

/* ---------------- Targeting ---------------- */

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

  if (best.host !== cur && best.score >= curScore * 1.15) {
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

/* ---------------- Singularity helpers (controller-side, no singularity API) ---------------- */

function isDesiredAugName(name) {
  const s = String(name).toLowerCase();

  // Hacking-ish vibes
  const hackingHit =
    s.includes("hack") ||
    s.includes("neuro") ||          // common prefix in hacking augs
    s.includes("synaptic") ||
    s.includes("bitwire") ||
    s.includes("cranial") ||
    s.includes("datajack") ||
    s.includes("c.r.t") ||
    s.includes("cognitive") ||
    s.includes("neural") ||
    s.includes("algorithm");

  // Charisma-ish vibes
  const chaHit =
    s.includes("charisma") ||
    s.includes("social") ||
    s.includes("negotiation") ||
    s.includes("speech") ||
    s.includes("persuasion") ||
    s.includes("presence") ||
    s.includes("empathy");

  return hackingHit || chaHit;
}

function readInvites(ns, path, fallback) {
  try {
    if (!ns.fileExists(path, "home")) return fallback;
    const obj = JSON.parse(ns.read(path));
    if (Array.isArray(obj?.invites)) return obj.invites.slice();
    return fallback;
  } catch {
    return fallback;
  }
}

function clampNumber(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function haveAugFacts(ctrl, aug) {
  const f = ctrl.augFacts?.[aug];
  return f && Number.isFinite(f.price) && Number.isFinite(f.repReq);
}

function pickFactionToWork(ns, CFG) {
  // We can read player factions without Singularity
  const factions = ns.getPlayer().factions ?? [];
  for (const f of CFG.factionPriority) if (factions.includes(f)) return f;
  return factions[0] ?? null;
}

function readPendingCount(ns, path, fallback) {
  try {
    if (!ns.fileExists(path, "home")) return fallback;
    const obj = JSON.parse(ns.read(path));
    if (typeof obj?.pendingCount === "number") return obj.pendingCount;
    if (Array.isArray(obj?.pending)) return obj.pending.length;
    return fallback;
  } catch {
    return fallback;
  }
}

function trySyscall(ns, ctrl, key, script, args = [], retryMs = 1000) {
  if (!ns.fileExists(script, "home")) return 0;

  const now = Date.now();
  const nextOk = ctrl.ensureBackoff?.[key] ?? 0;
  if (now < nextOk) return 0;

  const pid = ns.run(script, 1, ...args);
  if (pid === 0) {
    ctrl.ensureBackoff[key] = now + retryMs;
    return 0;
  }

  delete ctrl.ensureBackoff[key];
  return pid;
}
