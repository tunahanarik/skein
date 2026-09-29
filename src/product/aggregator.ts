/**
 * Aggregator coverage for Stock Tokens: which tokens can be routed on Robinhood Chain through
 * aggregators, and how the price compares with the token's Chainlink price.
 *
 * Two sources, each quoted for a fixed $100 USDG → token buy:
 *   KyberSwap  keyless, 30 req / 10 s: every token, every scan;
 *   LI.FI      keyless, 75 req / ~2 h (measured): a budget per scan, oldest-first, paused on 429.
 *              LI.FI adds Rialto, Fly, Nordstern and others on top of KyberSwap.
 * The row keeps the better of the two. Classes by value lost vs the oracle: GOOD ≤ 1%, OK ≤ 3%,
 * EXPENSIVE above (not executed by the web app). NO_ROUTE only when a source answered "no route";
 * rate limits and errors leave the previous result (or UNKNOWN). Rows persist in .cache.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { checkBridgeQuote, quote as lifiQuote, type Quote, type QuoteRequest } from "../../web/src/bridge/lifi.js";
import { kyberRoute, type KyberRoute } from "../../web/src/swap/kyber.js";

export const SCAN_USD = 100;
export const DEVIATION = { good: 0.01, ok: 0.03 } as const;
/** LI.FI sources we have verified (docs/research/dex-ecosystem.md). */
export const VERIFIED_TOOLS = new Set(["kyberswap", "openocean", "rialto", "lifiIntentsDex"]);
/** Venues KyberSwap may route through that we have verified (same research). */
export const VERIFIED_VENUES = new Set(["uniswap-v3", "uniswapv3", "uniswap-v4", "uniswap-v4-hookless", "ramses", "ramses-v2", "ramses-v3", "ramses-cl", "up-v3", "up-v2", "kittenswap", "alandale", "sushiswap-v3", "pancake-v3"]);
const PROBE_USER = "0x00000000000000000000000000000000c0ffee01" as const;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as const;

export type AggClass = "GOOD" | "OK" | "EXPENSIVE" | "NO_ROUTE" | "NO_PRICE" | "UNKNOWN";

export interface AggSource {
  via: "kyber" | "lifi";
  cls: AggClass;
  toolName: string | null;
  tool: string | null;
  verifiedTool: boolean;
  loss: number | null;
  checkedAt: string;
}

export interface AggRow {
  key: string;
  symbol: string;
  cls: AggClass;
  via: "kyber" | "lifi" | null;
  tool: string | null;
  toolName: string | null;
  verifiedTool: boolean;
  /** Value lost vs the oracle on a $100 buy, as a fraction (0.004 = 0.4%). */
  loss: number | null;
  impliedUsd: number | null;
  oracleUsd: number | null;
  checkedAt: string | null;
  sources: AggSource[];
}

export interface AggToken {
  key: string;
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

export function classify(loss: number | null): AggClass {
  if (loss === null) return "NO_PRICE";
  return loss <= DEVIATION.good ? "GOOD" : loss <= DEVIATION.ok ? "OK" : "EXPENSIVE";
}

const RANK: Record<AggClass, number> = { GOOD: 0, OK: 1, EXPENSIVE: 2, NO_PRICE: 3, NO_ROUTE: 4, UNKNOWN: 5 };
/** The better of a token's sources: usable class first, then lower loss. */
export function best(sources: AggSource[]): AggSource | null {
  return [...sources].sort((a, b) => RANK[a.cls] - RANK[b.cls] || (a.loss ?? 9) - (b.loss ?? 9))[0] ?? null;
}

export class AggregatorScanner {
  private rows = new Map<string, AggRow>();
  private running: Promise<void> | null = null;
  private lifiPausedUntil = 0;
  lastScanAt: string | null = null;

  constructor(
    private readonly deps: {
      tokens: () => Promise<AggToken[]>;
      /** Chainlink USD prices by registry key (number, for classification only). */
      prices: (keys: string[]) => Promise<Map<string, number>>;
      lifi?: (req: QuoteRequest) => Promise<Quote>;
      kyber?: (tokenIn: `0x${string}`, tokenOut: `0x${string}`, amountIn: bigint) => Promise<KyberRoute>;
      /** LI.FI quotes per scan (keyless quota is ~75 per 2 h; 15 every 30 min stays under it). */
      lifiBudget?: number;
      spacingMs?: number;
      file?: string;
      now?: () => Date;
    },
  ) {
    const f = deps.file;
    if (f && existsSync(f)) {
      try {
        const saved = JSON.parse(readFileSync(f, "utf8")) as { lastScanAt: string | null; rows: AggRow[] };
        for (const r of saved.rows ?? []) this.rows.set(r.key, r);
        this.lastScanAt = saved.lastScanAt ?? null;
      } catch {
        /* start fresh */
      }
    }
  }

  all(): AggRow[] {
    return [...this.rows.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  get(key: string): AggRow | null {
    return this.rows.get(key) ?? null;
  }

  /** Runs one scan (concurrent callers share it). */
  scan(): Promise<void> {
    this.running ??= this.run().finally(() => (this.running = null));
    return this.running;
  }

  private now() {
    return (this.deps.now ?? (() => new Date()))();
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private put(t: AggToken, s: AggSource, oracle: number | null) {
    const prev = this.rows.get(t.key);
    const sources = [...(prev?.sources ?? []).filter((x) => x.via !== s.via), s];
    const b = best(sources)!;
    this.rows.set(t.key, {
      key: t.key,
      symbol: t.symbol,
      cls: b.cls,
      via: b.cls === "NO_ROUTE" || b.cls === "UNKNOWN" ? null : b.via,
      tool: b.tool,
      toolName: b.toolName,
      verifiedTool: b.verifiedTool,
      loss: b.loss,
      impliedUsd: b.loss !== null && oracle ? oracle / (1 - b.loss) : null,
      oracleUsd: oracle,
      checkedAt: s.checkedAt,
      sources,
    });
  }

  private async run(): Promise<void> {
    const tokens = await this.deps.tokens();
    const usdgKey = `4663:${USDG.toLowerCase()}`;
    const prices = await this.deps.prices([...tokens.map((t) => t.key), usdgKey]);
    const usdg = prices.get(usdgKey) ?? 1;
    const amountIn = BigInt(SCAN_USD * 1e6);
    const spacing = this.deps.spacingMs ?? 400;
    const lossOf = (out: bigint, t: AggToken, oracle: number | null) => {
      const n = Number(out) / 10 ** t.decimals;
      return oracle && n > 0 ? 1 - (n * oracle) / (SCAN_USD * usdg) : null;
    };

    // KyberSwap: every token.
    const kyber = this.deps.kyber ?? ((a, b, c) => kyberRoute(a, b, c));
    for (const t of tokens) {
      const oracle = prices.get(t.key) ?? null;
      try {
        const r = await kyber(USDG, t.address, amountIn);
        const loss = lossOf(r.amountOut, t, oracle);
        this.put(t, { via: "kyber", cls: classify(loss), tool: "kyberswap", toolName: `KyberSwap · ${r.exchanges.join(", ") || "?"}`, verifiedTool: r.exchanges.length > 0 && r.exchanges.every((x) => VERIFIED_VENUES.has(x.toLowerCase())), loss, checkedAt: this.now().toISOString() }, oracle);
      } catch (e) {
        const m = (e as Error).message;
        if (/route not found|no route|not found/i.test(m)) this.put(t, { via: "kyber", cls: "NO_ROUTE", tool: null, toolName: null, verifiedTool: false, loss: null, checkedAt: this.now().toISOString() }, oracle);
        else if (/429|too many/i.test(m)) await this.sleep(10_000);
      }
      await this.sleep(spacing);
    }

    // LI.FI: a budget per scan, least recently checked first; stop at the first rate limit.
    if (Date.now() >= this.lifiPausedUntil) {
      const lifi = this.deps.lifi ?? ((r: QuoteRequest) => lifiQuote(r));
      const lastLifi = (t: AggToken) => this.rows.get(t.key)?.sources.find((s) => s.via === "lifi")?.checkedAt ?? "";
      const order = [...tokens].sort((a, b) => lastLifi(a).localeCompare(lastLifi(b))).slice(0, this.deps.lifiBudget ?? 15);
      for (const t of order) {
        const oracle = prices.get(t.key) ?? null;
        const req: QuoteRequest = { fromChainId: 4663, toChainId: 4663, fromToken: USDG, toToken: t.address, fromAmount: amountIn, user: PROBE_USER, slippage: 0.005, order: "CHEAPEST" };
        try {
          const r = await lifi(req);
          checkBridgeQuote(r, req);
          const loss = lossOf(r.toAmount, t, oracle);
          this.put(t, { via: "lifi", cls: classify(loss), tool: r.tool, toolName: `${r.toolName} · LI.FI`, verifiedTool: VERIFIED_TOOLS.has(r.tool), loss, checkedAt: this.now().toISOString() }, oracle);
        } catch (e) {
          const m = (e as Error).message;
          if (/too many|429|rate/i.test(m)) {
            this.lifiPausedUntil = Date.now() + 60 * 60_000;
            break;
          }
          if (/no available quotes|no routes?/i.test(m)) this.put(t, { via: "lifi", cls: "NO_ROUTE", tool: null, toolName: null, verifiedTool: false, loss: null, checkedAt: this.now().toISOString() }, oracle);
        }
        await this.sleep(spacing * 2);
      }
    }

    this.lastScanAt = this.now().toISOString();
    const f = this.deps.file;
    if (f) {
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, JSON.stringify({ lastScanAt: this.lastScanAt, rows: this.all() }));
    }
  }
}
