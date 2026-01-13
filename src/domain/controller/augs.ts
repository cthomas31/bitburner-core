import type { ControllerState, AugStats } from "/domain/controller/types.js";

export function clampNumber(x: unknown, fallback = 0): number {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
}

export function pruneAugFacts(ctrl: ControllerState, keepSet: Set<string>, maxKeep: number): void {
    if (!ctrl.augFacts) ctrl.augFacts = {};
    const keys = Object.keys(ctrl.augFacts);
    if (keys.length <= maxKeep) return;

    for (const k of keys) {
        if (!keepSet.has(k)) delete ctrl.augFacts[k];
    }
}

export function mult(stats: AugStats | undefined, key: keyof AugStats): number {
    const v = stats?.[key];
    const n = Number(v);
    return Number.isFinite(n) ? n : 1;
}

export function augValueHackCha(stats: AugStats | undefined): number {
    const hacking =
        2.0 * (mult(stats, "hacking_mult") - 1) +
        1.0 * (mult(stats, "hacking_exp_mult") - 1) +
        1.0 * (mult(stats, "hacking_speed_mult") - 1) +
        0.5 * (mult(stats, "hacking_money_mult") - 1) +
        0.5 * (mult(stats, "hacking_grow_mult") - 1);

    const charisma =
        1.5 * (mult(stats, "charisma_mult") - 1) +
        1.0 * (mult(stats, "charisma_exp_mult") - 1);

    return Math.max(0, hacking + charisma);
}

export function augRoiScore(stats: AugStats | undefined, price: number): number {
    const v = augValueHackCha(stats);
    if (!Number.isFinite(price) || price <= 0) return 0;
    return v / price;
}
