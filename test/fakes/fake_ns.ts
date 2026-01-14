import type { NS } from "@ns";

type WriteMode = "w" | "a" | undefined;

export class FakeNS
    implements Pick<NS, "read" | "write" | "print" | "tprint">
{
    private files = new Map<string, string>();
    logs: string[] = [];
    terminal: string[] = [];

    stock = {
        getSymbols: (): string[] => [],
        getPosition: (_sym: string): [number, number, number, number] => [
            0, 0, 0, 0,
        ],
        getAskPrice: (_sym: string): number => 0,
        getBidPrice: (_sym: string): number => 0,
    };

    getServerMoneyAvailable = (_host: string): number => 0;

    constructor(initialFiles?: Record<string, string>) {
        for (const [path, contents] of Object.entries(initialFiles ?? {})) {
            this.files.set(path, contents);
        }
    }

    read(path: string): string | null {
        return this.files.get(path) ?? null;
    }

    write(path: string, data: string | number | boolean, mode?: WriteMode) {
        const text = String(data);
        if (mode === "a" && this.files.has(path)) {
            const prev = this.files.get(path) ?? "";
            this.files.set(path, prev + text);
        } else {
            this.files.set(path, text);
        }
        return true;
    }

    print(msg: unknown): void {
        this.logs.push(String(msg));
    }

    tprint(msg: unknown): void {
        this.terminal.push(String(msg));
    }
}

export function makeFakeNS(initialFiles?: Record<string, string>): FakeNS {
    return new FakeNS(initialFiles);
}
