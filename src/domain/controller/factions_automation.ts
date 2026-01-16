import type { NS } from "@ns";
import { readJSON, writeJSON } from "/lib/ns/io.js";
import { clampNumber } from "/domain/controller/augs.js";
import {
    pickFactionToWorkSmart,
    readInvites,
} from "/domain/controller/factions.js";
import { trySyscall } from "/domain/controller/syscalls.js";
import type {
    ControllerConfig,
    ControllerState,
    DataPaths,
} from "/domain/controller/types.js";

export async function applyFactionRepFromFile(
    ns: NS,
    ctrl: ControllerState,
    dataPath: DataPaths
): Promise<void> {
    const repObj = (await readJSON(ns, dataPath.factionRep)) as {
        faction?: string;
        rep?: number;
    } | null;

    if (repObj?.faction === ctrl.chosenFaction) {
        ctrl.factionRep = clampNumber(repObj.rep, ctrl.factionRep ?? 0);
    }
}

export async function tickFactions(
    ns: NS,
    CFG: ControllerConfig,
    ctrl: ControllerState,
    now: number,
    dataPath: DataPaths
): Promise<"started_syscall" | "noop"> {
    // (A) Check invites periodically
    if (now - ctrl.lastJoinInvitesTs > CFG.joinInvitesEveryMs) {
        const key = "syscall:inv";
        const pid = trySyscall(
            ns,
            ctrl,
            key,
            "scripts/singularity/check-invites.js",
            [dataPath.invites],
            1000
        );
        if (pid !== 0) {
            ctrl.syscallPid = pid;
            ctrl.syscallKey = key;
            ctrl.lastJoinInvitesTs = now;
            return "started_syscall";
        }
    }

    // (B) Join one invite if present
    ctrl.invites = await readInvites(ns, dataPath.invites, ctrl.invites);
    if (ctrl.invites?.length) {
        const nextFaction = ctrl.invites[0];
        const key = "syscall:join-faction";
        const pid = trySyscall(
            ns,
            ctrl,
            key,
            "scripts/singularity/join-faction.js",
            [dataPath.joinOut, nextFaction],
            1000
        );
        if (pid !== 0) {
            ctrl.syscallPid = pid;
            ctrl.syscallKey = key;
            ctrl.invites.shift();
            writeJSON(ns, dataPath.invites, {
                ts: Date.now(),
                invites: ctrl.invites,
            });
            ctrl.statusMessages.push(
                new Date().toLocaleString() + `: Joined faction ${nextFaction}`
            );
            return "started_syscall";
        }
    }

    const ownedSet = ctrl.ownedSet ?? new Set<string>();
    ctrl.ownedSet ??= ownedSet;

    // Decide faction AFTER we know what we own and AFTER caches can be updated.
    // Falls back to priority list until caches fill in.
    ctrl.chosenFaction = pickFactionToWorkSmart(ns, CFG, ctrl, ownedSet);

    // (D) Refresh faction rep periodically
    if (
        ctrl.chosenFaction &&
        now - ctrl.lastFactionRepTs > CFG.factionRepEveryMs
    ) {
        const key = "syscall:get-faction-rep";
        const pid = trySyscall(
            ns,
            ctrl,
            key,
            "scripts/singularity/get-faction-rep.js",
            [dataPath.factionRep, ctrl.chosenFaction],
            1000
        );
        if (pid !== 0) {
            ctrl.syscallPid = pid;
            ctrl.syscallKey = key;
            ctrl.lastFactionRepTs = now;
            return "started_syscall";
        }
    }

    // (I) keep working for faction
    if (
        ctrl.chosenFaction &&
        now - ctrl.lastWorkFactionTs > CFG.workFactionEveryMs
    ) {
        const key = "syscall:work-faction";
        const pid = trySyscall(
            ns,
            ctrl,
            key,
            "scripts/singularity/work-faction.js",
            [
                dataPath.work,
                ctrl.chosenFaction,
                CFG.factionWorkType,
                false,
            ],
            1000
        );
        if (pid !== 0) {
            ctrl.syscallPid = pid;
            ctrl.syscallKey = key;
            ctrl.lastWorkFactionTs = now;
            return "started_syscall";
        }
    }

    return "noop";
}
