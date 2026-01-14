import { describe, expect, it } from "vitest";
import { shouldKillOnDrawdown } from "/app/stocks/logic.js";

describe("drawdown kill switch", () => {
    it("triggers liquidation when drawdown passes the threshold", () => {
        expect(shouldKillOnDrawdown(1000, 850, 0.1)).toBe(true);
    });

    it("stays active when drawdown is within limits", () => {
        expect(shouldKillOnDrawdown(1000, 950, 0.1)).toBe(false);
    });
});
