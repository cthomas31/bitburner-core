/** @param {NS} ns
 * args:
 *   0: actionScriptPath (string) — script on this host, e.g. /scripts/grow-once.js
 *   1: target (string)
 *   2: startTimeMs (number) — when to run (absolute Date.now() ms)
 *   3: requestedThreads (number)
 */
export async function main(ns) {
  ns.disableLog("sleep");

  const actionScript = String(ns.args[0] ?? "");
  const target = String(ns.args[1] ?? "");
  const startTime = Number(ns.args[2] ?? 0);
  const requestedThreads = Math.max(1, Math.floor(Number(ns.args[3] ?? 1)));

  const host = ns.getHostname();

  if (!actionScript || !target || !startTime) {
    ns.print("[timed-runner] missing args");
    return;
  }

  if (!ns.fileExists(actionScript, host)) {
    ns.print(`[timed-runner] action script ${actionScript} missing on ${host}`);
    return;
  }

  // Sleep until we’re close to the desired start time
  const now = Date.now();
  const msToWait = Math.max(0, startTime - now - 10); // wake up a bit early
  if (msToWait > 0) await ns.sleep(msToWait);

  // Final tiny sync nudge
  let remaining = startTime - Date.now();
  while (remaining > 5) {
    await ns.sleep(Math.min(remaining, 5));
    remaining = startTime - Date.now();
  }

  // At execution time, recompute how many threads we can *actually* run.
  const scriptRam = ns.getScriptRam(actionScript);
  if (!scriptRam || scriptRam <= 0) {
    ns.print(`[timed-runner] invalid scriptRam for ${actionScript}`);
    return;
  }

  const maxRam = ns.getServerMaxRam(host);
  const usedRam = ns.getServerUsedRam(host);
  const freeRam = Math.max(0, maxRam - usedRam);

  let maxThreads = Math.floor(freeRam / scriptRam);
  if (maxThreads <= 0) {
    // No room at all; just bail quietly.
    ns.print(
      `[timed-runner] not enough free RAM on ${host} for ${actionScript} ` +
      `(free=${freeRam.toFixed(2)} GB, need≥${scriptRam.toFixed(2)} GB)`
    );
    return;
  }

  // Cap by what we planned
  const threads = Math.min(requestedThreads, maxThreads);

  const pid = ns.exec(actionScript, host, threads, target);
  if (pid === 0) {
    ns.print(
      `[timed-runner] exec failed on ${host}: ${actionScript} ` +
      `threads=${threads} target=${target}`
    );
  } else {
    // Use ns.print to avoid spamming the main terminal window.
    ns.print(
      `[timed-runner] started ${actionScript} on ${host} ` +
      `threads=${threads} target=${target}`
    );
  }
}
