import type { NS } from "@ns";
import { DEFAULT_SETTINGS } from "/lib/settings-defaults.js";

let cachedSettings: Record<string, unknown> | null = null;

function parseUserSettings(ns: NS): Record<string, unknown> {
    try {
        const raw = ns.read("/settings.json");
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch (err) {
        ns.print(`[settings] failed to parse /settings.json: ${String(err)}`);
    }
    return {};
}

export function readSettings(ns: NS): Record<string, unknown> {
    if (cachedSettings) return cachedSettings;
    const user = parseUserSettings(ns);
    cachedSettings = { ...DEFAULT_SETTINGS, ...user };
    return cachedSettings;
}

export function reloadSettings(ns: NS): Record<string, unknown> {
    cachedSettings = null;
    return readSettings(ns);
}

function getValue(ns: NS, key: string): unknown {
    const settings = readSettings(ns);
    if (key in settings) return settings[key];
    if (key in DEFAULT_SETTINGS) return DEFAULT_SETTINGS[key];
    return undefined;
}

export function getNumber(ns: NS, key: string): number {
    const value = getValue(ns, key);
    const fallback = DEFAULT_SETTINGS[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    if (typeof fallback === "number" && Number.isFinite(fallback))
        return fallback;
    return 0;
}

export function getBool(ns: NS, key: string): boolean {
    const value = getValue(ns, key);
    const fallback = DEFAULT_SETTINGS[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.toLowerCase() === "true";
    if (typeof fallback === "boolean") return fallback;
    if (typeof fallback === "number") return fallback !== 0;
    return false;
}

export function getString(ns: NS, key: string): string {
    const value = getValue(ns, key);
    const fallback = DEFAULT_SETTINGS[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }
    if (typeof fallback === "string") return fallback;
    if (typeof fallback === "number" || typeof fallback === "boolean") {
        return String(fallback);
    }
    return "";
}

export function getStringArray(ns: NS, key: string): string[] {
    const value = getValue(ns, key);
    if (Array.isArray(value)) {
        return value.map((v) => String(v));
    }
    const fallback = DEFAULT_SETTINGS[key];
    if (Array.isArray(fallback)) {
        return fallback.map((v) => String(v));
    }
    return [];
}

export function getPrefix(ns: NS, prefix: string): Record<string, unknown> {
    const settings = readSettings(ns);
    const out: Record<string, unknown> = {};
    const pfx = prefix.endsWith(".") ? prefix : `${prefix}.`;
    for (const [k, v] of Object.entries(settings)) {
        if (k === prefix || k.startsWith(pfx)) {
            out[k] = v;
        }
    }
    return out;
}

function fnv1a32(s: string): number {
    let h = 0x811c9dc5; // offset basis
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        // 32-bit FNV prime multiply (via shifts to stay in 32-bit)
        h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
}

export function makeSettingsWatcher(
    ns: NS,
    path = "/settings.json",
    checkEveryMs = 2000
) {
    let lastCheck = 0;
    let lastHash: number | null = null;

    return function maybeReloadSettings() {
        const now = Date.now();
        let status = "";
        if (now - lastCheck < checkEveryMs) return;
        lastCheck = now;

        const raw = ns.read(path) ?? "";
        const hash = fnv1a32(raw);

        if (lastHash === null) {
            lastHash = hash; // first observation
            return;
        }

        if (hash !== lastHash) {
            lastHash = hash;
            reloadSettings(ns);
            status = `[settings] reloaded (hash=${hash})`;
        }
        return status;
    };
}
