import type { NS } from "@ns";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "/lib/settings-defaults.js";
import { getNumber, reloadSettings } from "/lib/settings.js";
import { makeFakeNS } from "./fakes/fake_ns";

const spreadKey = "stocks.trend.maxSpreadFrac";

describe("settings", () => {
    it("applies overrides and respects caching until reload", () => {
        const ns = makeFakeNS({
            "/settings.json": JSON.stringify({
                [spreadKey]: 0.02,
            }),
        });
        reloadSettings(ns as unknown as NS);

        expect(getNumber(ns as unknown as NS, spreadKey)).toBeCloseTo(0.02);

        ns.write(
            "/settings.json",
            JSON.stringify({
                [spreadKey]: 0.05,
            })
        );

        expect(getNumber(ns as unknown as NS, spreadKey)).toBeCloseTo(0.02);

        reloadSettings(ns as unknown as NS);
        expect(getNumber(ns as unknown as NS, spreadKey)).toBeCloseTo(0.05);
    });

    it("falls back to defaults on invalid JSON", () => {
        const ns = makeFakeNS({
            "/settings.json": "{not valid json",
        });
        reloadSettings(ns as unknown as NS);

        const fallback = DEFAULT_SETTINGS[spreadKey] as number;
        expect(getNumber(ns as unknown as NS, spreadKey)).toBeCloseTo(
            fallback
        );
        expect(ns.logs.some((line) => line.includes("failed to parse"))).toBe(
            true
        );
    });
});
