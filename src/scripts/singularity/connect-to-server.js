import { writeJSON } from "/lib/ns-io.js";

/** @param {NS} ns **/
export async function main(ns) {
  const hostname = String(ns.args[0] ?? "");
  const out = String(ns.args[1] ?? "data/singularity/connect-to-server.json");

  const ok = await ns.singularity.connect(hostname);
  await writeJSON(ns, out, { ts: Date.now(), hostname, ok });
}
