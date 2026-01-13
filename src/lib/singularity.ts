import { NS } from "@ns";
import { readJSON, writeJSON } from "/lib/ns/io.js";
import { errorMessage } from "/lib/error.js";
import { parseArg, ArgSpec, missingArg } from "/lib/ns/arg.js";


const SINGULARITY_SCRIPTS = "/scripts/singularity/";
const SINGULARITY_OUTPUT = "/data/singularity/";

export async function run(
    ns: NS,
    command: string,
    args: string[]
): Promise<any> {
    const scriptPath = SINGULARITY_SCRIPTS + command + ".js";
    const outputFile = SINGULARITY_OUTPUT + command + ".json";
    args = [outputFile, ...args];
    const pid = ns.exec(scriptPath, "home", 1, ...args);
    if (pid === 0) {
        ns.tprint(`Failed to start script: ${scriptPath}`);
        return null;
    }
    // Wait for the script to complete
    while (ns.isRunning(pid)) {
        await ns.sleep(500);
    }

    return await readJSON(ns, outputFile);
}

export type OneShotOk<T extends object> = { ts: number; ok: true } & T;
export type OneShotErr = { ts: number; ok: false; error: string; details?: unknown };
export type OneShotResult<T extends object> = OneShotOk<T> | OneShotErr;

/**
 * Wrapper for the "one expensive singularity call per script" pattern.
 *
 * Convention:
 *   ns.args[0] = out path (required)
 *   ns.args[1..] = declared args in spec.args
 */
export async function oneShot<T extends object>(
  ns: NS,
  spec: {
    args: ArgSpec[]; // starts at arg1
    run: (parsed: Record<string, unknown>) => T | Promise<T>;
  }
): Promise<void> {
  const out = String(ns.args[0] ?? "");
  if (!out) {
    // Can't write JSON without a path; just log and bail.
    ns.print("[oneShot] missing out path");
    return;
  }

  const parsed: Record<string, unknown> = {};
  for (let i = 0; i < spec.args.length; i++) {
    const a = spec.args[i];
    const val = parseArg(ns, i + 1, a);

    if (!a.optional && missingArg(val, a)) {
      const payload: OneShotErr = { ts: Date.now(), ok: false, error: `missing ${a.name}` };
      writeJSON(ns, out, payload);
      return;
    }
    parsed[a.name] = val;
  }

  try {
    const result = await spec.run(parsed);
    const payload: OneShotOk<T> = { ts: Date.now(), ok: true, ...result };
    writeJSON(ns, out, payload);
  } catch (e: unknown) {
    const payload: OneShotErr = {
      ts: Date.now(),
      ok: false,
      error: errorMessage(e),
      details: e,
    };
    writeJSON(ns, out, payload);
  }
}
