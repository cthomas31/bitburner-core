/**
 * network.ts
 *
 * Functions for scanning and mapping the server network.
 */

import type { NS, Server } from "@ns";

// ============== Type Definitions ==============

export interface ExploreContext {
    depth: number;
    parent: string | null;
}

export interface ExploreOptions {
    start?: string;
    visit: (host: string, ctx: ExploreContext) => void | boolean | Promise<void | boolean>;
}

export interface NetworkNode {
    name: string;
    depth: number;
    parent: string | null;
    backdoorInstalled: boolean;
    baseDifficulty: number;
    cpuCores: number;
    ftpPortOpen: boolean;
    hackDifficulty: number;
    hasAdminRights: boolean;
    hostname: string;
    httpPortOpen: boolean;
    ip: string;
    isConnectedTo: string[];
    maxRam: number;
    minDifficulty: number;
    moneyAvailable: number;
    moneyMax: number;
    numOpenPortsRequired: number;
    openPortCount: number;
    organizationName: string;
    purchasedByPlayer: boolean;
    ramUsed: number;
    requiredHackingSkill: number;
    serverGrowth: number;
    smtpPortOpen: boolean;
    sqlPortOpen: boolean;
    sshPortOpen: boolean;
    hackTime: number;
    growTime: number;
    weakenTime: number;
}

export type NetworkMap = Record<string, NetworkNode>;

// ============== Functions ==============

/**
 * Traverse the network graph starting at `start` and call `visit`
 * exactly once per discovered host.
 *
 * If visit() returns true, traversal stops early.
 */
export async function explore(
    ns: NS,
    { start = "home", visit }: ExploreOptions
): Promise<void> {
    if (typeof visit !== "function")
        throw new Error("explore: visit callback is required");

    const visited = new Set<string>();
    const stack: Array<{ host: string; depth: number; parent: string | null }> = [
        { host: start, depth: 0, parent: null }
    ];

    let item: { host: string; depth: number; parent: string | null } | undefined;
    while ((item = stack.pop()) !== undefined) {
        const { host, depth, parent } = item;
        if (visited.has(host)) continue;
        visited.add(host);

        // Allow async visitor; visitor may early-return true
        const stop = await visit(host, { depth, parent });
        if (stop === true) return;

        for (const neighbor of ns.scan(host)) {
            if (!visited.has(neighbor)) {
                stack.push({ host: neighbor, depth: depth + 1, parent: host });
            }
        }
    }
}

/**
 * Build a map of the entire server network starting from `start`.
 */
export async function buildNetworkMap(ns: NS, start = "home"): Promise<NetworkMap> {
    const network: NetworkMap = {};

    await explore(ns, {
        start,
        visit: (host, { depth, parent }) => {
            const s: Server = ns.getServer(host);
            network[host] = {
                name: host,
                depth,
                parent,
                backdoorInstalled: s.backdoorInstalled ?? false,
                baseDifficulty: s.baseDifficulty ?? 0,
                cpuCores: s.cpuCores,
                ftpPortOpen: s.ftpPortOpen,
                hackDifficulty: s.hackDifficulty ?? 0,
                hasAdminRights: s.hasAdminRights,
                hostname: s.hostname,
                httpPortOpen: s.httpPortOpen,
                ip: s.ip,
                isConnectedTo: ns.scan(host),
                maxRam: s.maxRam,
                minDifficulty: s.minDifficulty ?? 0,
                moneyAvailable: s.moneyAvailable ?? 0,
                moneyMax: s.moneyMax ?? 0,
                numOpenPortsRequired: s.numOpenPortsRequired ?? 0,
                openPortCount: s.openPortCount ?? 0,
                organizationName: s.organizationName,
                purchasedByPlayer: s.purchasedByPlayer,
                ramUsed: s.ramUsed,
                requiredHackingSkill: s.requiredHackingSkill ?? 0,
                serverGrowth: s.serverGrowth ?? 0,
                smtpPortOpen: s.smtpPortOpen,
                sqlPortOpen: s.sqlPortOpen,
                sshPortOpen: s.sshPortOpen,
                hackTime: ns.getHackTime(host),
                growTime: ns.getGrowTime(host),
                weakenTime: ns.getWeakenTime(host)
            };
        }
    });

    return network;
}

/**
 * Find a path from `start` to `target` server.
 *
 * @returns Array of hostnames from start to target, or null if target is not reachable.
 */
export async function findPath(
    ns: NS,
    target: string,
    start = "home"
): Promise<string[] | null> {
    const parent: Record<string, string | null> = {};
    let found = false;

    await explore(ns, {
        start,
        visit: (host, ctx) => {
            parent[host] = ctx.parent;
            if (host === target) {
                found = true;
                return true;    // stop traversal
            }
            return false;
        }
    });

    if (!found) return null;

    const path: string[] = [];
    let h: string | null = target;
    while (h !== null) {
        path.push(h);
        h = parent[h] ?? null;
    }
    return path.reverse();
}

/**
 * Get all rooted servers.
 *
 * @returns Array of hostnames
 */
export async function getRootedServers(ns: NS): Promise<string[]> {
    const results: string[] = [];
    await explore(ns, {
        start: "home",
        visit: (host) => {
            const s = ns.getServer(host);
            if (s.hasAdminRights && s.maxRam > 0) results.push(host);
        }
    });
    return results;
}
