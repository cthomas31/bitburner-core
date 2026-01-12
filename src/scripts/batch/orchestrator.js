/**
 * scripts/batch/orchestrator.js
 *
 * Multi-target, depth-saturating batch scheduler WITH dynamic target pool.
 *
 * Candidate source:
 * - /data/targets.json 
 * - Treat it as a candidate list and compute real formulas-based scores for batching.
 *
 * Assumes:
 * - Formulas.exe exists
 * - timed runner signature: timed-runner.js <actionScript> <target> <startTimeMs> <threads>
 */

import { BATCHER_CONFIG } from "/lib/constants.js";
import { readJSON } from "/lib/ns-io.js";

const TARGETS_FILE = "/data/targets.json";

/** @param {NS} ns **/
export async function main(ns) {
    ns.disableLog("sleep");
    ns.disableLog("exec");
    ns.disableLog("scp");
    ns.disableLog("getServerMaxRam");
    ns.disableLog("getServerUsedRam");

    const cfg = normalizeCfg(BATCHER_CONFIG);

    const explicitTarget = ns.args[0] ? String(ns.args[0]) : null;
    if (explicitTarget) ns.tprint(`[batch-orchestrator] explicit target lock: ${explicitTarget}`);

    const required = Object.values(cfg.actionScripts);
    const missing = required.filter(p => !ns.fileExists(p, "home"));
    if (missing.length) {
        ns.tprint(`[batch-orchestrator] missing scripts on home: ${missing.join(", ")}`);
        return;
    }

    /** @type {Map<string, any>} */
    const stateByTarget = new Map();

    /** dynamic target pool state */
    const poolState = {
        lastRefresh: 0,
        active: [],          // current chosen targets (strings)
        scores: new Map(),   // host -> computed score
    };

    for (; ;) {
        try {
            const player = ns.getPlayer();
            const workers = await getWorkers(ns, cfg);

            if (workers.length === 0) {
                ns.print("[batch-orchestrator] no workers available. sleeping...");
                await ns.sleep(1000);
                continue;
            }

            await ensureScriptsOnWorkers(ns, cfg, workers);

            const now = Date.now();

            // --- pick targets (dynamic pool) ---
            let targets;
            if (explicitTarget) {
                targets = [explicitTarget];
            } else {
                if (now - poolState.lastRefresh > cfg.targetRefreshMs) {
                    const picked = await pickTargetsDynamic(ns, cfg, player, workers, poolState);
                    poolState.active = picked;
                    poolState.lastRefresh = now;
                }
                targets = poolState.active.length ? poolState.active : await pickTargetsFallback(ns, cfg, player.skills.hacking);
            }

            ensureTargetState(stateByTarget, targets);

            // --- schedule work per target ---
            for (const target of targets) {
                const st = stateByTarget.get(target);
                if (!st) continue;

                if (st.cooldownUntil && now < st.cooldownUntil) continue;

                const server = ns.getServer(target);
                if (!server?.hasAdminRights || server.moneyMax <= 0) continue;

                const prepStatus = classifyPrep(server, cfg);
                if (prepStatus !== "READY") {
                    schedulePrep(ns, cfg, workers, target, server, player, st, now);
                    continue;
                }

                const plan = computeBatchPlan(ns, cfg, target, server, player);
                if (!plan.ok) {
                    st.lastError = plan.err;
                    continue;
                }

                const depthByTime = Math.max(1, Math.floor(plan.weakenTime / cfg.batchSpacingMs));
                const desiredDepth = clamp(Math.min(cfg.maxBatchesPerTarget, depthByTime), 1, cfg.maxBatchesPerTarget);

                if (!st.nextHackEndTime) {
                    st.nextHackEndTime = now + plan.maxActionTime + cfg.startBufferMs;
                }

                st.inflight = (st.inflight || []).filter(b => b.endWeaken2 > now);

                let scheduledAny = false;
                while (st.inflight.length < desiredDepth) {
                    const hackEnd = st.nextHackEndTime;
                    st.nextHackEndTime += cfg.batchSpacingMs;

                    const timings = makeTimings(cfg, plan, hackEnd);
                    const assignment = allocateBatch(ns, cfg, workers, plan, timings);

                    if (!assignment) {
                        st.cooldownUntil = Date.now() + cfg.ramStarvationCooldownMs;
                        st.lastError = "RAM_STARVATION";
                        break;
                    }

                    dispatchBatch(ns, cfg, target, assignment);

                    st.inflight.push({
                        hackEnd: timings.endHack,
                        endWeaken2: timings.endWeaken2,
                    });

                    scheduledAny = true;
                }

                if (scheduledAny) st.lastError = null;
            }

            if (cfg.statusEveryMs > 0) maybePrintStatus(ns, cfg, stateByTarget, workers, poolState);

        } catch (e) {
            ns.print(`[batch-orchestrator] ERROR: ${String(e)}`);
        }

        await ns.sleep(cfg.tickMs);
    }
}


/** Normalize and fill in default config values. 
 *  @param {object} cfgIn
 *  @return {object} normalized config
 */
function normalizeCfg(cfgIn) {
    const cfg = { ...cfgIn };

    cfg.tickMs = Number(cfg.tickMs ?? 125);
    cfg.batchSpacingMs = Number(cfg.batchSpacingMs ?? 400);
    cfg.maxBatchesPerTarget = Number(cfg.maxBatchesPerTarget ?? 40);
    cfg.startBufferMs = Number(cfg.startBufferMs ?? 600);
    cfg.ramStarvationCooldownMs = Number(cfg.ramStarvationCooldownMs ?? 750);

    cfg.useHomeAsWorker = Boolean(cfg.useHomeAsWorker ?? false);
    cfg.reserveHomeRamGb = Number(cfg.reserveHomeRamGb ?? 256);
    cfg.homeScheduleBufferGb = Number(cfg.homeScheduleBufferGb ?? 32);

    // Dynamic pool knobs
    cfg.targetRefreshMs = Number(cfg.targetRefreshMs ?? 15_000);
    cfg.candidateLimit = Number(cfg.candidateLimit ?? 30); // how many from targets.json we even evaluate
    cfg.maxTargets = Number(cfg.maxTargets ?? 6);          // absolute cap on parallel targets
    cfg.minTargets = Number(cfg.minTargets ?? 2);          // always try to have at least this many
    cfg.minTargetRamShareGb = Number(cfg.minTargetRamShareGb ?? 64); // must have this much free RAM "headroom" per target to include it
    cfg.targetHysteresisKeep = Number(cfg.targetHysteresisKeep ?? 0.88); // keep existing targets if they are within 88% of cutoff score

    cfg.offsets = cfg.offsets ?? { hack: 0, weaken1: 100, grow: 200, weaken2: 300 };

    cfg.prep = cfg.prep ?? {};
    cfg.prep.moneyFracMin = Number(cfg.prep.moneyFracMin ?? 0.95);
    cfg.prep.secAboveMin = Number(cfg.prep.secAboveMin ?? 2.0);

    cfg.statusEveryMs = Number(cfg.statusEveryMs ?? 2000);

    cfg.actionScripts = cfg.actionScripts ?? {
        hack: "/scripts/hack-once.js",
        grow: "/scripts/grow-once.js",
        weaken: "/scripts/weaken-once.js",
        timedRunner: "/scripts/batch/timed-runner.js",
    };

    cfg.hackFractionPerBatch = Number(cfg.hackFractionPerBatch ?? 0.10);

    return cfg;
}


/** Clamp a number n to be within the inclusive range [lo, hi]. 
 * 
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @return {number}
 */
function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
}


/**
 * Compute a real formulas-based score for each candidate:
 * score = (profitPerSecond / ramPerBatch)
 *
 * profitPerSecond assumes you can start 1 batch every batchSpacingMs when saturated.
 * This matches the “pipeline” reality: throughput is spacing-limited, not weaken-time-limited,
 * as long as depth >= 1 (it always is).
 * 
 * @param {NS} ns
 * @param {object} cfg
 * @param {object} player
 * @param {{host:string, max:number, used:number, free:number}[]} workers
 * @param {object} poolState
 * @return {Promise<string[]>} chosen target hostnames
 */
async function pickTargetsDynamic(ns, cfg, player, workers, poolState) {
    const hackLevel = player.skills.hacking;

    const candidates = await readCandidatesFromTargetsJson(ns, cfg, hackLevel);
    if (!candidates.length) return [];

    // Total free RAM across workers (rough capacity signal)
    const totalFree = workers.reduce((a, w) => a + w.free, 0);

    // @type {{host:string, score:number, ramPerBatch:number}[]} 
    const scored = [];

    for (const host of candidates) {
        const s = ns.getServer(host);
        if (!s?.hasAdminRights || s.moneyMax <= 0) continue;

        // Use a "prepped" snapshot for scoring
        const prepped = { ...s, hackDifficulty: s.minDifficulty, moneyAvailable: s.moneyMax };

        const plan = computeBatchPlan(ns, cfg, host, prepped, player);
        if (!plan.ok) continue;

        const ramPerBatch = estimateRamPerBatch(ns, cfg, plan);
        if (ramPerBatch <= 0) continue;

        const profitPerBatch = prepped.moneyMax * clamp(cfg.hackFractionPerBatch, 0.01, 0.5);
        const profitPerSec = profitPerBatch / (cfg.batchSpacingMs / 1000);
        const score = profitPerSec / ramPerBatch; // $/sec/GB

        scored.push({ host, score, ramPerBatch });
        poolState.scores.set(host, score);
    }

    scored.sort((a, b) => b.score - a.score);

    // Capacity-based selection:
    // Require some headroom per target, then pick up to maxTargets.
    const maxByCapacity = Math.max(
        cfg.minTargets,
        Math.min(cfg.maxTargets, Math.floor(totalFree / cfg.minTargetRamShareGb))
    );

    const cutoffIndex = Math.min(scored.length, maxByCapacity) - 1;
    const cutoffScore = cutoffIndex >= 0 ? scored[cutoffIndex].score : 0;

    // Hysteresis: keep existing targets if they’re “close enough” to cutoff.
    const keepSet = new Set();
    for (const t of poolState.active) {
        const s = poolState.scores.get(t) ?? 0;
        if (s >= cutoffScore * cfg.targetHysteresisKeep) keepSet.add(t);
    }

    const chosen = [];
    for (const x of scored) {
        if (chosen.length >= maxByCapacity) break;
        if (keepSet.has(x.host)) {
            chosen.push(x.host);
        }
    }
    for (const x of scored) {
        if (chosen.length >= maxByCapacity) break;
        if (!chosen.includes(x.host)) chosen.push(x.host);
    }

    return chosen;
}


/**
 * Find best XP target by scanning all servers.
 * @param {NS} ns
 * @param {object} fallback
 * @return {{hostname:string, score:number, hackTime:number, expPerHack:number}}
 */
async function readCandidatesFromTargetsJson(ns, cfg, hackLevel) {
    // Treat targets.json as “candidate list”, not authoritative order.
    const rows = await readJSON(ns, TARGETS_FILE);
    if (!Array.isArray(rows) || !rows.length) return [];

    const hosts = [];
    for (const r of rows) {
        let host = null;
        let req = null;

        if (typeof r === "string") {
            host = r;
        } else if (r && typeof r === "object") {
            host = String(r.host ?? r.hostname ?? r.server ?? "");
            req = Number(r.reqHack ?? r.requiredHackingSkill ?? r.req ?? NaN);
        }

        if (!host || !ns.serverExists(host) || !ns.hasRootAccess(host)) continue;

        const reqHack = Number.isFinite(req) ? req : ns.getServerRequiredHackingLevel(host);
        if (reqHack > hackLevel) continue;

        if (ns.getServerMaxMoney(host) <= 0) continue;

        hosts.push(host);
        if (hosts.length >= cfg.candidateLimit) break;
    }

    return hosts;
}


/** Fallback target picker: scan all servers, pick highest max money ones within hack level. 
 * @param {NS} ns
 * @param {object} cfg
 * @param {number} hackLevel
 * @return {Promise<string[]>} chosen target hostnames
 */
async function pickTargetsFallback(ns, cfg, hackLevel) {
    const all = scanAll(ns).filter(h => ns.hasRootAccess(h));
    const elig = all
        .filter(h => ns.getServerRequiredHackingLevel(h) <= hackLevel)
        .filter(h => ns.getServerMaxMoney(h) > 0)
        .map(h => ({ host: h, money: ns.getServerMaxMoney(h) }))
        .sort((a, b) => b.money - a.money)
        .slice(0, cfg.minTargets)
        .map(x => x.host);

    return elig;
}


/** Estimate RAM usage per batch based on plan. 
 * @param {NS} ns
 * @param {object} cfg
 * @param {object} plan
 * @return {number} RAM in GB
 */
function estimateRamPerBatch(ns, cfg, plan) {
    // include a conservative runner overhead (one timed-runner per action chunk)
    const hackRam = ns.getScriptRam(cfg.actionScripts.hack) || 1.7;
    const growRam = ns.getScriptRam(cfg.actionScripts.grow) || 1.7;
    const weakRam = ns.getScriptRam(cfg.actionScripts.weaken) || 1.7;
    const runner = ns.getScriptRam(cfg.actionScripts.timedRunner) || 1.7;

    // We don’t know chunk count ahead of time, so just count “at least 4” runners.
    return (
        plan.hackThreads * hackRam +
        plan.growThreads * growRam +
        (plan.weaken1Threads + plan.weaken2Threads) * weakRam +
        4 * runner
    );
}


/** Scan all servers in the network starting from "home". 
 * @param {NS} ns
 * @return {string[]} list of hostnames
*/
function scanAll(ns) {
    const seen = new Set(["home"]);
    const q = ["home"];
    while (q.length) {
        const h = q.shift();
        for (const n of ns.scan(h)) {
            if (!seen.has(n)) {
                seen.add(n);
                q.push(n);
            }
        }
    }
    return [...seen];
}

/** Ensure state map matches current target list. 
 * @param {Map<string, any>} stateByTarget
 * @param {string[]} targets
 */
function ensureTargetState(stateByTarget, targets) {
    for (const t of targets) {
        if (!stateByTarget.has(t)) {
            stateByTarget.set(t, {
                inflight: [],
                nextHackEndTime: 0,
                cooldownUntil: 0,
                lastError: null,
            });
        }
    }
    for (const k of [...stateByTarget.keys()]) {
        if (!targets.includes(k)) stateByTarget.delete(k);
    }
}


/** Get list of worker servers including purchased servers and optionally home. 
 * @param {NS} ns
 * @param {object} cfg
 * @return {Promise<Array<{host: string, max: number, used: number, free: number}>>}
 */
async function getWorkers(ns, cfg) {
    const hosts = [];

    for (const h of ns.getPurchasedServers()) hosts.push(h);
    if (cfg.useHomeAsWorker) hosts.push("home");

    const workers = hosts
        .map(h => {
            const max = ns.getServerMaxRam(h);
            const maxUsable = h === "home" && cfg.reserveHomeRamGb > 0 ? Math.max(0, max - cfg.reserveHomeRamGb) : max;
            const used = ns.getServerUsedRam(h);
            const free = h === "home" ? Math.max(0, maxUsable - used - cfg.homeScheduleBufferGb) : Math.max(0, maxUsable - used);

            return { host: h, max, used, free };
        })
        .filter(w => w.free >= 1.75)
        .sort((a, b) => b.free - a.free);

    return workers;
}

/** Ensure all action scripts are present on all workers.
 * @param {NS} ns
 * @param {object} cfg
 * @param {Array<{host:string, max:number, used:number, free:number}>} workers
*/
async function ensureScriptsOnWorkers(ns, cfg, workers) {
    const files = Object.values(cfg.actionScripts);
    for (const w of workers) {
        if (!ns.fileExists(cfg.actionScripts.timedRunner, w.host)) {
            await ns.scp(files, w.host);
        }
    }
}


/** Classify whether a server needs preparation or is ready for hacking.
 * @param {object} server
 * @param {object} cfg
 * @return {"READY"|"NEEDS_PREP"}
 */
function classifyPrep(server, cfg) {
    const moneyOk = server.moneyAvailable >= server.moneyMax * cfg.prep.moneyFracMin;
    const secOk = server.hackDifficulty <= server.minDifficulty + cfg.prep.secAboveMin;
    if (moneyOk && secOk) return "READY";
    return "NEEDS_PREP";
}

/** Schedule prep actions (weaken/grow) as needed.
 * @param {NS} ns
 * @param {object} cfg
 * @param {Array<{host:string, max:number, used:number, free:number}>} workers
 * @param {string} target
 * @param {object} server
 * @param {object} player
 * @param {object} st
 * @param {number} now
*/
function schedulePrep(ns, cfg, workers, target, server, player, st, now) {
    const weakenScript = cfg.actionScripts.weaken;
    const growScript = cfg.actionScripts.grow;
    const timedRunner = cfg.actionScripts.timedRunner;

    const weakenRam = ns.getScriptRam(weakenScript) || 1.75;
    const growRam = ns.getScriptRam(growScript) || 1.75;
    const runnerRam = ns.getScriptRam(timedRunner) || 1.75;

    const weakenTime = getWeakenTime(ns, server, player);
    const growTime = getGrowTime(ns, server, player);

    const secOver = server.hackDifficulty - server.minDifficulty;
    const moneyFrac = server.moneyMax > 0 ? (server.moneyAvailable / server.moneyMax) : 1;

    if (secOver > cfg.prep.secAboveMin) {
        const threads = estimateWeakenThreads(ns, secOver, 1);
        const end = now + weakenTime + 250;
        const start = end - weakenTime;

        const assigned = allocateSimple(workers, threads, weakenRam, runnerRam);
        if (!assigned) { st.cooldownUntil = now + cfg.ramStarvationCooldownMs; return; }

        for (const a of assigned) ns.exec(timedRunner, a.host, 1, weakenScript, target, start, a.threads);
        return;
    }

    if (moneyFrac < cfg.prep.moneyFracMin) {
        const growThreads = estimateGrowThreads(ns, target, server.moneyMax);
        const growSec = ns.growthAnalyzeSecurity(growThreads, target);
        const weakenThreads = estimateWeakenThreads(ns, growSec, 1);

        const hackEnd = now + Math.max(weakenTime, growTime) + 250;

        const endGrow = hackEnd + 0;
        const endWeaken = hackEnd + 100;

        const startGrow = endGrow - growTime;
        const startWeaken = endWeaken - weakenTime;

        const gAssigned = allocateSimple(workers, growThreads, growRam, runnerRam);
        if (!gAssigned) { st.cooldownUntil = now + cfg.ramStarvationCooldownMs; return; }
        for (const a of gAssigned) ns.exec(timedRunner, a.host, 1, growScript, target, startGrow, a.threads);

        const wAssigned = allocateSimple(workers, weakenThreads, weakenRam, runnerRam);
        if (!wAssigned) { st.cooldownUntil = now + cfg.ramStarvationCooldownMs; return; }
        for (const a of wAssigned) ns.exec(timedRunner, a.host, 1, weakenScript, target, startWeaken, a.threads);
    }
}


/** Compute a batch plan using formulas, estimating threads and timings.
    * @param {NS} ns
    * @param {object} cfg
    * @param {string} target
    * @param {object} server
    * @param {object} player
    * @return {object} plan or error { ok: false, err: string }
 */
function computeBatchPlan(ns, cfg, target, server, player) {
    try {
        if (!ns.fileExists("Formulas.exe", "home") || !ns.formulas?.hacking) {
            return { ok: false, err: "NO_FORMULAS" };
        }

        const s = { ...server };
        s.hackDifficulty = s.minDifficulty;
        s.moneyAvailable = s.moneyMax;

        const hackPercent = ns.formulas.hacking.hackPercent(s, player);
        if (!hackPercent || hackPercent <= 0) return { ok: false, err: "HACK_PERCENT_ZERO" };

        const hackFrac = clamp(cfg.hackFractionPerBatch, 0.01, 0.50);
        const hackThreads = Math.max(1, Math.ceil(hackFrac / hackPercent));

        const moneyAfterHack = Math.max(1, s.moneyMax * (1 - hackFrac));

        let growThreads = 1;
        try {
            growThreads = Math.max(1, Math.ceil(ns.formulas.hacking.growThreads(s, player, s.moneyMax, moneyAfterHack)));
        } catch {
            const growFactor = s.moneyMax / Math.max(1, moneyAfterHack);
            growThreads = Math.max(1, Math.ceil(ns.growthAnalyze(target, growFactor)));
        }

        const hackSec = ns.hackAnalyzeSecurity(hackThreads, target);
        const growSec = ns.growthAnalyzeSecurity(growThreads, target);

        const weakenEffect = ns.weakenAnalyze(1, 1);
        const weaken1Threads = Math.max(1, Math.ceil(hackSec / weakenEffect));
        const weaken2Threads = Math.max(1, Math.ceil(growSec / weakenEffect));

        const hackTime = ns.formulas.hacking.hackTime(s, player);
        const growTime = ns.formulas.hacking.growTime(s, player);
        const weakenTime = ns.formulas.hacking.weakenTime(s, player);
        const maxActionTime = Math.max(hackTime, growTime, weakenTime);

        return {
            ok: true,
            target,
            hackThreads,
            growThreads,
            weaken1Threads,
            weaken2Threads,
            hackTime,
            growTime,
            weakenTime,
            maxActionTime,
        };
    } catch (e) {
        return { ok: false, err: String(e) };
    }
}

/** Given a plan and desired hackEnd time, compute action timings. 
 * @param {object} cfg
 * @param {object} plan
 * @param {number} hackEnd
 * @return {object} timings
*/
function makeTimings(cfg, plan, hackEnd) {
    // offsets are end-time offsets after hackEnd
    const endHack = hackEnd + cfg.offsets.hack;
    const endWeaken1 = hackEnd + cfg.offsets.weaken1;
    const endGrow = hackEnd + cfg.offsets.grow;
    const endWeaken2 = hackEnd + cfg.offsets.weaken2;

    return {
        endHack,
        endWeaken1,
        endGrow,
        endWeaken2,
        startHack: endHack - plan.hackTime,
        startWeaken1: endWeaken1 - plan.weakenTime,
        startGrow: endGrow - plan.growTime,
        startWeaken2: endWeaken2 - plan.weakenTime,
    };
}


/** Allocate threads for each action in a batch across available workers. 
 * @param {NS} ns
 * @param {object} cfg
 * @param {Array<{host:string, max:number, used:number, free:number}>} workers
 * @param {object} plan
 * @param {object} timings
 * @return {Array<{name:string, script:string, threads:number, ramPerThread:number, start:number, chunks:Array<{host:string, threads:number}>}>}|null
 */
function allocateBatch(ns, cfg, workers, plan, timings) {
    // allocate each action independently, consuming from worker free RAM snapshots
    const w = workers.map(x => ({ ...x }));

    const hackRam = ns.getScriptRam(cfg.actionScripts.hack) || 1.7;
    const growRam = ns.getScriptRam(cfg.actionScripts.grow) || 1.7;
    const weakRam = ns.getScriptRam(cfg.actionScripts.weaken) || 1.7;
    const runnerRam = ns.getScriptRam(cfg.actionScripts.timedRunner) || 1.7;

    const tasks = [
        { name: "hack", script: cfg.actionScripts.hack, threads: plan.hackThreads, ramPerThread: hackRam, start: timings.startHack },
        { name: "weaken1", script: cfg.actionScripts.weaken, threads: plan.weaken1Threads, ramPerThread: weakRam, start: timings.startWeaken1 },
        { name: "grow", script: cfg.actionScripts.grow, threads: plan.growThreads, ramPerThread: growRam, start: timings.startGrow },
        { name: "weaken2", script: cfg.actionScripts.weaken, threads: plan.weaken2Threads, ramPerThread: weakRam, start: timings.startWeaken2 },
    ];

    const assignment = [];
    for (const t of tasks) {
        const chunks = allocateThreads(w, t.threads, t.ramPerThread, runnerRam);
        if (!chunks) return null;
        assignment.push({ ...t, chunks });
    }

    return assignment;
}

/** Allocate threads across workers for a given action. 
 * @param {Array<{host:string, max:number, used:number, free:number}>} workers
 * @param {number} totalThreads
 * @param {number} ramPerThread
 * @param {number} runnerRam
 * @return {Array<{host:string, threads:number}>}|null
 */
function allocateThreads(workers, totalThreads, ramPerThread, runnerRam) {
    let remaining = totalThreads;
    const chunks = [];

    for (const w of workers) {
        if (remaining <= 0) break;
        if (w.free < runnerRam + ramPerThread) continue;

        const maxThreadsHere = Math.floor((w.free - runnerRam) / ramPerThread);
        if (maxThreadsHere <= 0) continue;

        const take = Math.min(remaining, maxThreadsHere);

        w.free -= (runnerRam + take * ramPerThread);
        chunks.push({ host: w.host, threads: take });
        remaining -= take;
    }

    if (remaining > 0) return null;
    return chunks;
}

/** Dispatch a batch by executing timed-runner on each chunk. 
 * @param {NS} ns
 * @param {object} cfg
 * @param {string} target
 * @param {Array<{name:string, script:string, threads:number, ramPerThread:number, start:number, chunks:Array<{host:string, threads:number}>}>} assignment
 */
function dispatchBatch(ns, cfg, target, assignment) {
    const runner = cfg.actionScripts.timedRunner;
    for (const t of assignment) {
        for (const c of t.chunks) {
            ns.exec(runner, c.host, 1, t.script, target, Math.floor(t.start), c.threads);
        }
    }
}


/** Simple allocation helper for prep actions. 
 * @param {Array<{host:string, max:number, used:number, free:number}>} workers
 * @param {number} totalThreads
 * @param {number} actionRam
 * @param {number} runnerRam
 * @return {Array<{host:string, threads:number}>}|null
*/
function allocateSimple(workers, totalThreads, actionRam, runnerRam) {
    const w = workers.map(x => ({ ...x }));
    const chunks = allocateThreads(w, totalThreads, actionRam, runnerRam);
    return chunks;
}

/** Get weaken time using formulas if available, fallback to API.
 * @param {NS} ns
 * @param {object} server
 * @param {object} player
 * @return {number} weaken time in ms
 */
function getWeakenTime(ns, server, player) {
    try {
        const s = { ...server };
        return ns.formulas?.hacking?.weakenTime ? ns.formulas.hacking.weakenTime(s, player) : ns.getWeakenTime(server.hostname);
    } catch {
        return ns.getWeakenTime(server.hostname);
    }
}

/** Get grow time using formulas if available, fallback to API. 
 * @param {NS} ns
 * @param {object} server
 * @param {object} player
 * @return {number} grow time in ms
*/
function getGrowTime(ns, server, player) {
    try {
        const s = { ...server };
        return ns.formulas?.hacking?.growTime ? ns.formulas.hacking.growTime(s, player) : ns.getGrowTime(server.hostname);
    } catch {
        return ns.getGrowTime(server.hostname);
    }
}

/** Estimate weaken threads needed to remove given security. 
 * @param {NS} ns
 * @param {number} secToRemove
 * @param {number} cores
 * @return {number} threads needed
 */
function estimateWeakenThreads(ns, secToRemove, cores) {
    const effect = ns.weakenAnalyze(1, cores);
    return Math.max(1, Math.ceil(secToRemove / effect));
}

/** Estimate grow threads needed to reach target money. 
 * @param {NS} ns
 * @param {string} target
 * @param {number} targetMoney
 * @return {number} threads needed
 */
function estimateGrowThreads(ns, target, targetMoney) {
    const money = Math.max(1, ns.getServerMoneyAvailable(target));
    const factor = Math.max(1.01, targetMoney / money);
    return Math.max(1, Math.ceil(ns.growthAnalyze(target, factor)));
}


/** Maybe print status information periodically. 
 * @param {NS} ns
 * @param {object} cfg
 * @param {Map<string, any>} stateByTarget
 * @param {Array<{host:string, max:number, used:number, free:number}>} workers
 * @param {object} poolState
*/
let _lastStatus = 0;
function maybePrintStatus(ns, cfg, stateByTarget, workers, poolState) {
    const now = Date.now();
    if (now - _lastStatus < cfg.statusEveryMs) return;
    _lastStatus = now;

    const totalFree = workers.reduce((a, w) => a + w.free, 0);
    const totalMax = workers.reduce((a, w) => a + w.max, 0);

    ns.print(`[batch-orchestrator] workers=${workers.length} free=${totalFree.toFixed(1)}GB max=${totalMax.toFixed(1)}GB`);
    ns.print(`[batch-orchestrator] targets=[${poolState.active.join(", ")}]`);

    for (const [t, st] of stateByTarget.entries()) {
        const inflight = (st.inflight || []).length;
        const err = st.lastError ? ` err=${st.lastError}` : "";
        ns.print(`  ${t}: inflight=${inflight}${err}`);
    }
}
