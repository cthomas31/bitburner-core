import type { NS } from "@ns";
import { getNumber, reloadSettings } from "/lib/settings.js";

/** @param {NS} ns **/
export async function main(ns: NS): Promise<void> {
  reloadSettings(ns);
  const raw = ns.read("/settings.json");
  ns.tprint(`[diag] raw length=${raw?.length ?? 0}`);
  ns.tprint(`[diag] getNumber(stocks.trend.maxSpreadFrac)=${getNumber(ns, "stocks.trend.maxSpreadFrac")}`);

  try {
    const parsed = JSON.parse(raw);
    const v = parsed["stocks.trend.maxSpreadFrac"];
    ns.tprint(`[diag] JSON.parse key value=${String(v)} type=${typeof v}`);
    ns.tprint(`[diag] hasKey=${Object.prototype.hasOwnProperty.call(parsed, "stocks.trend.maxSpreadFrac")}`);
  } catch (e) {
    ns.tprint(`[diag] JSON.parse FAILED: ${String(e)}`);
    // show a snippet so you can spot trailing commas / garbage
    ns.tprint(`[diag] raw head: ${raw.slice(0, 200)}`);
    ns.tprint(`[diag] raw tail: ${raw.slice(Math.max(0, raw.length - 200))}`);
  }
}
