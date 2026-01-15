import type { NS } from "@ns";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface StockLogBase {
    ts: string;
    runId: string;
    tick?: number;
    level: LogLevel;
    event: string;

    cash?: number;
    equity?: number;
    equityPeak?: number;
    pausedUntil?: number | null;
}

export interface StockLoggerOpts {
    file: string; // e.g. "/logs/stock-manager.jsonl"
    flushEvery?: number; // default 25
    flushIntervalMs?: number; // default 2000
    minLevel?: LogLevel; // default "info"
    alsoPrint?: boolean; // default false
    maxFileBytes?: number; // optional: basic rotation
}

const LEVEL_RANK: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

export class StockLogger {
    private buf: string[] = [];
    private lastFlush = 0;

    constructor(
        private ns: NS,
        private runId: string,
        private opts: StockLoggerOpts
    ) {
        this.opts.flushEvery ??= 25;
        this.opts.flushIntervalMs ??= 2000;
        this.opts.minLevel ??= "info";
        this.opts.alsoPrint ??= false;
        this.lastFlush = Date.now();
    }

    log(
        level: LogLevel,
        event: string,
        data: Omit<StockLogBase, "ts" | "runId" | "level" | "event"> &
            Record<string, unknown> = {}
    ) {
        if (LEVEL_RANK[level] < LEVEL_RANK[this.opts.minLevel ?? "info"]) return;

        const rec: StockLogBase & Record<string, unknown> = {
            ts: new Date().toISOString(),
            runId: this.runId,
            level,
            event,
            ...data,
        };

        const line = JSON.stringify(rec);
        this.buf.push(line);

        if (this.opts.alsoPrint) this.ns.print(line);

        const now = Date.now();
        if (
            this.buf.length >= (this.opts.flushEvery ?? 25) ||
            now - this.lastFlush >= (this.opts.flushIntervalMs ?? 2000)
        ) {
            this.flush();
        }
    }

    flush() {
        if (this.buf.length === 0) return;

        // Optional ultra-simple rotation by size (best-effort)
        if (this.opts.maxFileBytes) {
            const size = this.safeFileSize(this.opts.file);
            if (size !== null && size > this.opts.maxFileBytes) {
                const rotated =
                    this.opts.file.replace(/\.jsonl$/, "") + `.old.jsonl`;
                // We can’t rename in Netscript; easiest is overwrite old, then start fresh.
                // If you have a file mgmt helper, use it here.
                this.ns.write(rotated, this.ns.read(this.opts.file), "w");
                this.ns.write(this.opts.file, "", "w");
            }
        }

        const payload = this.buf.join("\n") + "\n";
        this.ns.write(this.opts.file, payload, "a");
        this.buf = [];
        this.lastFlush = Date.now();
    }

    // Netscript read() returns "" for missing; we can estimate bytes via length.
    private safeFileSize(path: string): number | null {
        try {
            const s = this.ns.read(path);
            return typeof s === "string" ? s.length : null;
        } catch {
            return null;
        }
    }
}
