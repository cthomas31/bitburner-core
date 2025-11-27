/**
 * hack-loop.js
 *
 * A self-contained loop that weakens, grows, or hacks a target server.
 * Arguments:
 *   target (string) - name of the server to attack (default: "n00dles").
 *   moneyPct (number) - fraction (0.0-1.0) of max money to keep before hacking (default: 0.9).
 *   secMargin (number) - additional security above minimum before weakening (default: 2).
 *
 * The script will attempt to keep the target near its max money and minimum security.
 * It is deliberately conservative to avoid over-hacking: hack is only executed once the server is at or
 * above moneyPct * maxMoney and security is below the threshold.
 */

/** @param {NS} ns */
export async function main(ns) {
  const target    = ns.args[0] || 'n00dles';
  const moneyPct  = ns.args.length > 1 ? parseFloat(ns.args[1]) : 0.9;
  const secMargin = ns.args.length > 2 ? parseInt(ns.args[2]) : 2;
  const debug     = ns.args.length > 3 && ns.args[3] == 'debug';

  // Precompute static thresholds
  const maxMoney    = ns.getServerMaxMoney(target);
  const minSecurity = ns.getServerMinSecurityLevel(target);
  const moneyThresh = maxMoney * moneyPct;
  const securityThresh = minSecurity + secMargin;

  // Introduce a random delay to reduce the chance of all loops synchronizing their actions.
  await ns.sleep(Math.floor(Math.random() * 5000));

  while (true) {
    const currentSec = ns.getServerSecurityLevel(target);
    const currentMoney = ns.getServerMoneyAvailable(target);

    if (currentSec > securityThresh) {
      if (debug) ns.print(`weaken: ${currentSec.toFixed(2)} > ${securityThresh.toFixed(2)}`);
      const wResult = await ns.weaken(target);
      if (debug) ns.print(`weakened ${target} by ${wResult.toFixed(2)} security`);
    } else if (currentMoney < moneyThresh) {
      if (debug) ns.print(`grow: ${currentMoney.toFixed(2)} < ${moneyThresh.toFixed(2)}`);
      const gResult = await ns.grow(target);
      if (debug) ns.print(`grew ${target} by a factor of ${gResult.toFixed(2)}`);
    } else {
      if (debug) ns.print(`hack: ${currentMoney.toFixed(2)} >= ${moneyThresh.toFixed(2)} and ${currentSec.toFixed(2)} <= ${securityThresh.toFixed(2)}`);
      const hResult = await ns.hack(target);
      if (debug) ns.print(`hacked ${target} for $${hResult.toFixed(2)}`);
    }
    // Yield to allow other scripts to run
    await ns.sleep(10);
  }
}