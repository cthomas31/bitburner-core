import type { NS } from "@ns";

type WriteMode = "w" | "a" | undefined;

type FakeStockInit = {
    bid: number;
    ask: number;
    maxShares?: number;
    forecast?: number;
    vol?: number;
    longShares?: number;
    longPx?: number;
    shortShares?: number;
    shortPx?: number;
};

type FakeStockEntry = {
    bid: number;
    ask: number;
    maxShares: number;
    forecast: number;
    vol: number;
    longShares: number;
    longPx: number;
    shortShares: number;
    shortPx: number;
};

type FakeNsOpts = {
    cash?: number;
    stocks?: Record<string, FakeStockInit>;
    enable4S?: boolean;
};

export class FakeNS
    implements Pick<NS, "read" | "write" | "print" | "tprint">
{
    private files = new Map<string, string>();
    logs: string[] = [];
    terminal: string[] = [];
    orders: { sym: string; side: string; shares: number }[] = [];
    private cash: number;
    private stockState: Record<string, FakeStockEntry> = {};
    private enable4S: boolean;

    stock = {
        getSymbols: (): string[] => Object.keys(this.stockState),
        getPosition: (sym: string): [number, number, number, number] => {
            const s = this.ensureStock(sym);
            return [s.longShares, s.longPx, s.shortShares, s.shortPx];
        },
        getAskPrice: (sym: string): number => this.ensureStock(sym).ask,
        getBidPrice: (sym: string): number => this.ensureStock(sym).bid,
        getMaxShares: (sym: string): number =>
            this.ensureStock(sym).maxShares,
        buyStock: (sym: string, shares: number): number => {
            const s = this.ensureStock(sym);
            const cost = s.ask * shares;
            const totalCost = s.longPx * s.longShares + cost;
            s.longShares += shares;
            s.longPx = s.longShares > 0 ? totalCost / s.longShares : 0;
            this.cash -= cost;
            this.orders.push({ sym, side: "BUY", shares });
            return cost;
        },
        sellStock: (sym: string, shares: number): number => {
            const s = this.ensureStock(sym);
            const proceeds = s.bid * shares;
            s.longShares = Math.max(0, s.longShares - shares);
            if (s.longShares === 0) s.longPx = 0;
            this.cash += proceeds;
            this.orders.push({ sym, side: "SELL", shares });
            return proceeds;
        },
        buyShort: (sym: string, shares: number): number => {
            const s = this.ensureStock(sym);
            const credit = s.bid * shares;
            const totalProceeds = s.shortPx * s.shortShares + credit;
            s.shortShares += shares;
            s.shortPx =
                s.shortShares > 0 ? totalProceeds / s.shortShares : 0;
            this.cash += credit;
            this.orders.push({ sym, side: "SHORT", shares });
            return credit;
        },
        sellShort: (sym: string, shares: number): number => {
            const s = this.ensureStock(sym);
            const cost = s.ask * shares;
            s.shortShares = Math.max(0, s.shortShares - shares);
            if (s.shortShares === 0) s.shortPx = 0;
            this.cash -= cost;
            this.orders.push({ sym, side: "COVER", shares });
            return cost;
        },
        getConstants: () => ({ StockMarketCommission: 0 }),
        has4SDataTIXAPI: (): boolean => this.enable4S,
        getForecast: (sym: string): number => this.ensureStock(sym).forecast,
        getVolatility: (sym: string): number => this.ensureStock(sym).vol,
    };

    getServerMoneyAvailable = (_host: string): number => this.cash;

    constructor(initialFiles?: Record<string, string>, opts?: FakeNsOpts) {
        for (const [path, contents] of Object.entries(initialFiles ?? {})) {
            this.files.set(path, contents);
        }
        this.cash = opts?.cash ?? 0;
        this.enable4S = opts?.enable4S ?? false;
        for (const [sym, init] of Object.entries(opts?.stocks ?? {})) {
            this.stockState[sym] = {
                bid: init.bid,
                ask: init.ask,
                maxShares: init.maxShares ?? 1_000_000_000,
                forecast: init.forecast ?? 0.6,
                vol: init.vol ?? 0.05,
                longShares: init.longShares ?? 0,
                longPx: init.longPx ?? 0,
                shortShares: init.shortShares ?? 0,
                shortPx: init.shortPx ?? 0,
            };
        }
    }

    read(path: string): string {
        return this.files.get(path) ?? "";
    }

    write(filename: string, data = "", mode: WriteMode = "w"): void {
        const text = String(data);
        if (mode === "a" && this.files.has(filename)) {
            const prev = this.files.get(filename) ?? "";
            this.files.set(filename, prev + text);
        } else {
            this.files.set(filename, text);
        }
    }

    print(msg: unknown): void {
        this.logs.push(String(msg));
    }

    tprint(msg: unknown): void {
        this.terminal.push(String(msg));
    }

    private ensureStock(sym: string): FakeStockEntry {
        if (!this.stockState[sym]) {
            this.stockState[sym] = {
                bid: 0,
                ask: 0,
                maxShares: 0,
                forecast: 0,
                vol: 0.05,
                longShares: 0,
                longPx: 0,
                shortShares: 0,
                shortPx: 0,
            };
        }
        return this.stockState[sym];
    }
}

export function makeFakeNS(
    initialFiles?: Record<string, string>,
    opts?: FakeNsOpts
): FakeNS {
    return new FakeNS(initialFiles, opts);
}
