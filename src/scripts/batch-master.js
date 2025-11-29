/** @param {NS} ns
 *
 * Batch master orchestrator.
 *
 * Usage:
 *   run scripts/batch-master.js
 *
 * Behavior:
 * - Picks a best target (you can adapt to use your targets.json or lib/targets.js)
 * - Computes threads and timings using ns.formulas.hacking when available
 * - Picks available worker hosts and schedules batches by launching timed-runner on the workers
 */

import { BATCHER_CONFIG } from "/lib/constants.js";

/** @param {NS} ns */
export async function main(ns) {
  ns.disableLog("sleep");
  const cfg = BATCHER_CONFIG;

  // Optional explicit target: first arg, if provided.
  const explicitTarget = ns.args[0] ? String(ns.args[0]) : null;
  if (explicitTarget) {
    ns.tprint(`[batch-master] locking to explicit target: ${explicitTarget}`);
  }

  if (cfg.dryRun) ns.tprint("[batch-master] running in dryRun mode");

  // sanity: ensure action scripts exist on home (for scp)
  const missing = [];
  for (const k of Object.values(cfg.actionScripts)) {
    if (!ns.fileExists(k, "home")) missing.push(k);
  }
  if (missing.length) {
    ns.tprint("[batch-master] Missing required action/timed-runner scripts on home: " + missing.join(", "));
    ns.tprint("[batch-master] Copy the small action scripts to home and try again.");
    return;
  }

  for (;;) {
    try {
      await planOneCycle(ns, cfg, explicitTarget);
    } catch (e) {
      ns.print("[batch-master] ERROR: " + String(e));
    }
    await ns.sleep(cfg.managerLoopMs);
  }
}

async function planOneCycle(ns, cfg, explicitTarget) {
  let target = explicitTarget;

  // 1) If no explicit target, fall back to targets.json / lib/targets.js
  if (!target) {
    try {
      const raw = ns.read("/data/targets.json");
      if (raw && raw.length) {
        const targets = JSON.parse(raw);
        if (Array.isArray(targets) && targets.length) {
          const t0 = targets[0];
          if (typeof t0 === "string") {
            target = t0;
          } else if (t0 && typeof t0 === "object") {
            target = t0.hostname || t0.host || t0.name || null;
          }
        }
      }
    } catch (e) {
      ns.print(`[batch-master] failed to read/parse targets.json: ${e}`);
    }

    if (!target) {
      try {
        const tgtlib = await import("/lib/targets.js");
        if (typeof tgtlib.getBestTarget === "function") {
          const best = tgtlib.getBestTarget(ns, "money");
          if (typeof best === "string") {
            target = best;
          } else if (best && typeof best === "object") {
            target = best.hostname || best.host || best.name || null;
          }
        }
      } catch (e) {
        ns.print(`[batch-master] failed to import/use lib/targets.js: ${e}`);
      }
    }
  }

  if (!target || typeof target !== "string") {
    ns.print("[batch-master] No valid target hostname found (expected string).");
    return;
  }

  const server = ns.getServer(target);
  const player = ns.getPlayer();

  // Must have root
  if (!server || !server.hasAdminRights) {
    ns.print(`[batch-master] No root on ${target}; skipping.`);
    return;
  }

  // 2) compute batch numbers using Formulas if available
  if (!ns.formulas || !ns.formulas.hacking) {
    ns.print("[batch-master] Formulas API not available. Batcher requires Formulas.exe for accurate batch math.");
    ns.print("[batch-master] You can still use simpler HWG loop scripts.");
    return;
  }

  const fh = ns.formulas.hacking;
  const srvObj = ns.getServer(target);

  // Gather timing info (ms)
  const hackTime = Math.ceil(fh.hackTime(srvObj, player));
  const growTime = Math.ceil(fh.growTime(srvObj, player));
  const weakenTime = Math.ceil(fh.weakenTime(srvObj, player));

  // compute hackThreads to steal a fraction of max money
  const moneyMax = srvObj.moneyMax;
  const moneyAvailable = srvObj.moneyAvailable;

  // hack percent per thread (0..1)
  const pctPerThread = fh.hackPercent(srvObj, player);
  const hackThreads = Math.max(1, Math.ceil((cfg.hackFractionPerBatch) / pctPerThread));

  // simulate money after hack to compute grow threads needed to get back to moneyMax
  const moneyStolen = Math.min(moneyAvailable, Math.floor(moneyAvailable * pctPerThread * hackThreads));
  const moneyAfterHack = Math.max(1, moneyAvailable - moneyStolen);

  // compute required grow threads using formulas.growThreads if available
  let growThreads;
  if (typeof fh.growThreads === "function") {
    // growThreads(server, player, targetMoney?) some versions expect server, player, targetMoney
    // We'll try both common signatures safely
    try {
      growThreads = Math.max(1, Math.ceil(fh.growThreads(Object.assign({}, srvObj, { moneyAvailable: moneyAfterHack }), player, moneyMax)));
    } catch (e) {
      try {
        // alternative: growThreads(server, player, growthMultiplier)
        const mult = moneyMax / moneyAfterHack;
        growThreads = Math.max(1, Math.ceil(fh.growThreads(Object.assign({}, srvObj, { moneyAvailable: moneyAfterHack }), player, mult)));
      } catch (err) {
        // fallback later
        growThreads = null;
      }
    }
  }

  // fallback: use ns.growthAnalyze if available
  if (!growThreads) {
    if (typeof ns.growthAnalyze === "function") {
      const multiplier = moneyMax / moneyAfterHack;
      try {
        growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, multiplier)));
      } catch (e) {
        growThreads = 1;
      }
    } else {
      growThreads = 1;
    }
  }

  // compute weaken threads required to offset security increases (use formulas if available)
  // We'll compute security increase from hack and grow using the formulas api:
  let secIncreaseFromHack = 0;
  let secIncreaseFromGrow = 0;
  try {
    // formulas provides securityIncrease for hack/grow? use the "hackPercent" and known constants if not.
    // Many examples use formula: each hack thread increases security by 0.002 and grow by 0.004.
    secIncreaseFromHack = 0.002 * hackThreads;
    secIncreaseFromGrow = 0.004 * growThreads;
  } catch (e) {
    secIncreaseFromHack = 0.002 * hackThreads;
    secIncreaseFromGrow = 0.004 * growThreads;
  }
  const totalSecToRemove = secIncreaseFromHack + secIncreaseFromGrow;
  // weaken reduces security by 0.05 per thread (game constant)
  const weakenThreads = Math.max(1, Math.ceil(totalSecToRemove / 0.05));

  // 3) calculate RAM needed for one batch and ensure we have workers that can host it
  const hackScriptRam = ns.getScriptRam(cfg.actionScripts.hack);
  const growScriptRam = ns.getScriptRam(cfg.actionScripts.grow);
  const weakenScriptRam = ns.getScriptRam(cfg.actionScripts.weaken);
  const runnerRam = ns.getScriptRam(cfg.actionScripts.timedRunner);

  const totalRamPerBatch = hackThreads * hackScriptRam
                          + growThreads * growScriptRam
                          + weakenThreads * weakenScriptRam
                          + 3 * runnerRam; // one runner per action start

  if (cfg.verbose) {
    ns.print(`[batch-master] target=${target} h=${hackThreads} g=${growThreads} w=${weakenThreads} ram/batch=${ns.nFormat(totalRamPerBatch,"0.00")}GB`);
    ns.print(`[batch-master] times: hack=${ns.tFormat(hackTime)} grow=${ns.tFormat(growTime)} weak=${ns.tFormat(weakenTime)}`);
  }

  // 4) select worker hosts with enough free RAM
  const candidates = [];
  const allHosts = await discoverRootedServers(ns);
  for (const h of allHosts) {
    if (h === "home") continue; // optional: avoid using home for heavy execs
    const free = ns.getServerMaxRam(h) - ns.getServerUsedRam(h);
    if (free >= cfg.minWorkerFreeRam) candidates.push({host: h, free});
  }
  candidates.sort((a,b)=> b.free - a.free);

  // quick capacity check: count aggregated free ram across top N hosts
  let aggFree = 0;
  for (const c of candidates) aggFree += c.free;
  if (aggFree < totalRamPerBatch) {
    ns.print("[batch-master] Not enough aggregate free RAM to run a batch; skipping this cycle.");
    return;
  }

  // 5) schedule a single batch (could be extended to plan multiple batches with spacing)
  // compute a base end time: the soonest time we can have all scripts finish (we use now + maxDur + padding)
  const now = Date.now();
  const maxActionTime = Math.max(hackTime, growTime, weakenTime);
  const baseEndTime = now + maxActionTime + 300; // small buffer

  // compute each action's startTime = baseEndTime - actionDuration - offset
  const startHack = baseEndTime - hackTime - cfg.offsets.hack;
  const startWeaken1 = baseEndTime - weakenTime - cfg.offsets.weaken1;
  const startGrow = baseEndTime - growTime - cfg.offsets.grow;
  const startWeaken2 = baseEndTime - weakenTime - cfg.offsets.weaken2;

  // 6) deploy: decide which hosts run which action threads.
  // Simpler approach: pick one large host per action and run all threads there if it has the RAM;
  // otherwise distribute by filling largest hosts first.

  const assignments = prepareAssignments(ns, candidates, [
    {action:"hack", threads:hackThreads, ramPerThread: hackScriptRam},
    {action:"weaken1", threads: Math.ceil(weakenThreads/2), ramPerThread: weakenScriptRam},
    {action:"grow", threads: growThreads, ramPerThread: growScriptRam},
    {action:"weaken2", threads: Math.floor(weakenThreads/2), ramPerThread: weakenScriptRam}
  ]);

  if (!assignments) {
    ns.print("[batch-master] failed to assign threads to hosts (insufficient distribution)"); return;
  }

  // 7) pre-copy required action scripts and timed-runner to all selected hosts
  const hostsToPush = new Set();
  assignments.forEach(a => a.hosts.forEach(h=> hostsToPush.add(h.hostname)));
  for (const h of hostsToPush) {
    try {
      if (cfg.dryRun) {
        ns.print(`[batch-master][dry] would scp files to ${h}`);
      } else {
        await ns.scp(Object.values(cfg.actionScripts), h);
      }
    } catch (e) {
      ns.print(`[batch-master] scp to ${h} failed: ${String(e)}`);
      return;
    }
  }

  // 8) launch timed-runner on each assigned host to execute the action at the scheduled time.
  const mapping = {
    hack: { start: startHack, script: cfg.actionScripts.hack },
    weaken1: { start: startWeaken1, script: cfg.actionScripts.weaken },
    grow: { start: startGrow, script: cfg.actionScripts.grow },
    weaken2: { start: startWeaken2, script: cfg.actionScripts.weaken }
  };

  // For each assignment (which may split threads across multiple hosts), exec timed-runner
  for (const task of assignments) {
    const map = mapping[task.action];
    for (const chunk of task.hosts) {
      const host = chunk.hostname;
      const tcount = chunk.threads;
      const startTime = Math.floor(map.start);
      if (cfg.dryRun) {
        ns.print(`[batch-master][dry] schedule ${task.action} ${tcount} threads on ${host} at ${new Date(startTime).toISOString()}`);
        continue;
      }
      const pid = ns.exec(cfg.actionScripts.timedRunner, host, 1, map.script, target, startTime, tcount);
      if (pid === 0) {
        ns.print(`[batch-master] failed to exec timed-runner on ${host} for ${task.action}`);
      } else {
        if (cfg.verbose) ns.print(`[batch-master] scheduled ${task.action} x${tcount} on ${host} at ${new Date(startTime).toISOString()}`);
      }
    }
  }
}

/** Helper: scan network for rooted servers (home included) */
async function discoverRootedServers(ns) {
  const result = new Set();
  const toVisit = ["home"];
  while (toVisit.length) {
    const cur = toVisit.pop();
    if (result.has(cur)) continue;
    result.add(cur);
    const children = ns.scan(cur);
    for (const c of children) {
      try { toVisit.push(c); } catch (e) { ns.print(`discoverRootedServers: scan error on ${cur} -> ${c}: ${String(e)}`)}
    }
  }
  // filter for rooted & scriptable
  return Array.from(result).filter(h => {
    try {
      const s = ns.getServer(h);
      return s && s.hasAdminRights && s.maxRam > 0;
    } catch (e) { return false; }
  });
}

/** Prepare assignments: greedily pack threads onto largest hosts first.
 *  tasks: [{action, threads, ramPerThread}]
 *  returns: [{action, hosts: [{hostname, threads}], totalThreads}] or null
 */
function prepareAssignments(ns, candidates, tasks) {
  // shallow copy candidate list (host, free)
  const pool = candidates.map(c => ({ hostname: c.host, free: c.free * 0.90 })); // 10% safety margin

  // helper: allocate 'count' threads of ramPerThread across pool
  const allocate = (count, ramPerThread) => {
    const res = [];
    let remainingThreads = count;
    // sort pool descending free
    pool.sort((a,b)=> b.free - a.free);
    for (const p of pool) {
      if (remainingThreads <= 0) break;
      const canThreads = Math.floor(p.free / ramPerThread);
      if (canThreads <= 0) continue;
      const take = Math.min(canThreads, remainingThreads);
      res.push({ hostname: p.hostname, threads: take });
      p.free -= take * ramPerThread;
      remainingThreads -= take;
    }
    if (remainingThreads > 0) return null;
    return res;
  };

  const assignments = [];
  for (const t of tasks) {
    const hostsForTask = allocate(t.threads, t.ramPerThread);
    if (!hostsForTask) return null;
    assignments.push({ action: t.action, hosts: hostsForTask, totalThreads: t.threads });
  }
  return assignments;
}
