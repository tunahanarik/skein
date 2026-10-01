/**
 * Price charts for day / week / month / year.
 *
 *   Stock Tokens  the underlying share's price history (Robinhood market data) × the token's
 *                 on-chain uiMultiplier. Used only if its latest close agrees with the token's
 *                 Chainlink price within MAX_DEVIATION (identity and unit check); otherwise the
 *                 chart falls back to Chainlink.
 *   ETH, USDG,    every Chainlink round of the feed's current phase, read on-chain, cached on
 *   fallback      disk and extended incrementally (only new rounds are read).
 *
 * Series are resampled to even buckets (last value per bucket, carried forward) so the line does
 * not jump with the feed's irregular update times.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import type { ChainReader } from "../chain/reader.js";
import { chainlinkAggregatorAbi } from "../config/abis.js";
import { formatFixed, parseFixed } from "../lib/units.js";
import type { ChartRange, ShareBar } from "../sources/rhMarket.js";

export const MAX_DEVIATION = 0.05;
export const RANGE_MS: Record<ChartRange, number> = { "1D": 86_400_000, "1W": 7 * 86_400_000, "1M": 30 * 86_400_000, "1Y": 365 * 86_400_000 };
export const BUCKET_MS: Record<ChartRange, number> = { "1D": 5 * 60_000, "1W": 30 * 60_000, "1M": 2 * 3_600_000, "1Y": 86_400_000 };
/** How long a chart may be served from cache. */
export const CHART_TTL_MS: Record<ChartRange, number> = { "1D": 60_000, "1W": 5 * 60_000, "1M": 15 * 60_000, "1Y": 60 * 60_000 };

export interface ChartPoint {
  t: string;
  usd: string;
  /** Pre/post-market bar (share data only). */
  ext?: boolean;
}

export interface PriceChartData {
  range: ChartRange;
  source: { provider: "ROBINHOOD_MARKET_DATA"; symbol: string; multiplier: string; url: string } | { provider: "CHAINLINK"; feed: string; proxy: string };
  points: ChartPoint[];
  first: string | null;
  last: string | null;
  high: string | null;
  low: string | null;
  /** Percent change over the shown series (percent units, e.g. "1.25"). */
  changePct: string | null;
  /** Set when data starts later than the range (e.g. a feed younger than a year). */
  since: string | null;
  /** Why share data was not used, if it was tried. */
  note: string | null;
  generatedAt: string;
}

/** Last value per bucket, carried forward; the value before the window seeds the first bucket. */
export function resample(pts: readonly { t: number; v: bigint; ext?: boolean }[], from: number, to: number, bucket: number): { t: number; v: bigint; ext?: boolean }[] {
  const sorted = [...pts].sort((a, b) => a.t - b.t);
  let i = 0;
  let cur: { v: bigint; ext?: boolean } | null = null;
  while (i < sorted.length && sorted[i]!.t < from) cur = sorted[i++]!;
  const out: { t: number; v: bigint; ext?: boolean }[] = [];
  const start = Math.floor(from / bucket) * bucket;
  for (let b = start; b <= to; b += bucket) {
    while (i < sorted.length && sorted[i]!.t < b + bucket) cur = sorted[i++]!;
    if (cur) out.push({ t: b, v: cur.v, ...(cur.ext ? { ext: true } : {}) });
  }
  return out;
}

/** `since`: when the data starts later than the range asks for (e.g. a listing or a young feed), else null. */
export function summarize(range: ChartRange, pts: { t: number; v: bigint; ext?: boolean }[], decimals: number, since: number | null): Omit<PriceChartData, "source" | "note" | "generatedAt"> {
  const f = (v: bigint) => formatFixed(v, decimals);
  if (!pts.length) return { range, points: [], first: null, last: null, high: null, low: null, changePct: null, since: null };
  const first = pts[0]!.v;
  const last = pts.at(-1)!.v;
  const hi = pts.reduce((m, p) => (p.v > m ? p.v : m), first);
  const lo = pts.reduce((m, p) => (p.v < m ? p.v : m), first);
  return {
    range,
    points: pts.map((p) => ({ t: new Date(p.t).toISOString(), usd: f(p.v), ...(p.ext ? { ext: true } : {}) })),
    first: f(first),
    last: f(last),
    high: f(hi),
    low: f(lo),
    changePct: first > 0n ? formatFixed(((last - first) * 10n ** 20n) / first, 18) : null,
    since: since !== null ? new Date(since).toISOString() : null,
  };
}

/** Share bars × multiplier (1e18) → token price points, 1e18-scaled. */
export function shareToToken(bars: readonly ShareBar[], multiplierE18: bigint): { t: number; v: bigint; ext?: boolean }[] {
  return bars.map((b) => ({ t: b.t, v: (parseFixed(b.close, 18) * multiplierE18) / 10n ** 18n, ...(b.extended ? { ext: true } : {}) }));
}

/** |a − b| / b as a number. */
export function deviation(a: bigint, b: bigint): number {
  if (b <= 0n) return Infinity;
  const d = a > b ? a - b : b - a;
  return Number((d * 1_000_000n) / b) / 1_000_000;
}

interface FeedCache {
  phase: string;
  lastAgg: string;
  decimals: number;
  rounds: [number, string][]; // [updatedAt seconds, answer]
}

/**
 * All rounds of a Chainlink feed's current phase. First use backfills from round 1 (batched
 * multicalls); later uses read only the rounds added since. Cached in memory and on disk.
 */
export class ChainlinkRounds {
  private readonly mem = new Map<string, FeedCache>();
  private readonly inflight = new Map<string, Promise<FeedCache>>();

  constructor(private readonly reader: Pick<ChainReader, "multicall">, private readonly opts: { dir?: string; batch?: number; maxRounds?: number } = {}) {}

  async get(proxy: Address, blockNumber: bigint): Promise<{ decimals: number; rounds: { t: number; v: bigint }[] }> {
    const key = proxy.toLowerCase();
    let p = this.inflight.get(key);
    if (!p) {
      p = this.update(key as Address, blockNumber).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const c = await p;
    return { decimals: c.decimals, rounds: c.rounds.map(([t, a]) => ({ t: t * 1000, v: BigInt(a) })) };
  }

  private file(key: string) {
    return this.opts.dir ? join(this.opts.dir, `${key}.json`) : null;
  }

  private load(key: string): FeedCache | null {
    const hit = this.mem.get(key);
    if (hit) return hit;
    const f = this.file(key);
    if (f && existsSync(f)) {
      try {
        const c = JSON.parse(readFileSync(f, "utf8")) as FeedCache;
        if (Array.isArray(c.rounds) && typeof c.lastAgg === "string") return c;
      } catch {
        /* rebuild */
      }
    }
    return null;
  }

  private async update(proxy: Address, blockNumber: bigint): Promise<FeedCache> {
    const key = proxy.toLowerCase();
    const [latest, dec] = await this.reader.multicall(
      [
        { address: proxy, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" },
        { address: proxy, abi: chainlinkAggregatorAbi, functionName: "decimals" },
      ],
      { blockNumber },
    );
    if (latest?.status !== "success" || dec?.status !== "success") throw new Error("feed unreadable");
    const rid = (latest.result as readonly bigint[])[0]!;
    const phase = rid >> 64n;
    const agg = rid & ((1n << 64n) - 1n);
    const decimals = Number(dec.result);
    let c = this.load(key);
    if (!c || c.phase !== phase.toString() || c.decimals !== decimals || BigInt(c.lastAgg) > agg) c = { phase: phase.toString(), lastAgg: "0", decimals, rounds: [] };
    const maxRounds = BigInt(this.opts.maxRounds ?? 20_000);
    let from = BigInt(c.lastAgg) + 1n;
    if (agg - from + 1n > maxRounds) from = agg - maxRounds + 1n;
    const batch = BigInt(this.opts.batch ?? 150);
    const fresh: [number, string][] = [];
    for (let s = from; s <= agg; s += batch) {
      const ids: bigint[] = [];
      for (let i = s; i < s + batch && i <= agg; i++) ids.push((phase << 64n) | i);
      const rs = await this.reader.multicall(ids.map((id) => ({ address: proxy, abi: chainlinkAggregatorAbi, functionName: "getRoundData", args: [id] })), { blockNumber });
      for (const r of rs) {
        if (r?.status !== "success") continue;
        const row = r.result as readonly bigint[];
        if (row.length >= 4 && row[1]! > 0n && row[3]! > 0n) fresh.push([Number(row[3]), row[1]!.toString()]);
      }
    }
    const merged = new Map<number, string>(c.rounds);
    for (const [t, a] of fresh) merged.set(t, a);
    const next: FeedCache = { phase: phase.toString(), lastAgg: agg.toString(), decimals, rounds: [...merged.entries()].sort((a, b) => a[0] - b[0]) };
    this.mem.set(key, next);
    const f = this.file(key);
    if (f && fresh.length) {
      mkdirSync(this.opts.dir!, { recursive: true });
      writeFileSync(f, JSON.stringify(next));
    }
    return next;
  }
}
