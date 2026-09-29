/**
 * Live prices: pool (pair) spot prices and token USD prices, pushed to browsers over
 * Server-Sent Events (GET /api/stream).
 *
 * Only what someone is watching is read. Every POLL_MS the hub reads, in ONE multicall at the
 * latest block:
 *   pairs   slot0() of v3-style pools (Uniswap v3, Ramses) and StateView.getSlot0(poolId) of
 *           Uniswap v4 pools, for the watched assets' most liquid markets;
 *   prices  latestRoundData() of the watched assets' Chainlink feeds.
 * Each subscriber receives a snapshot on connect, then only values that changed.
 * No wallet data is involved; the query names assets only.
 */
import type { Address, Hex } from "viem";
import type { ChainReader } from "../chain/reader.js";
import { chainlinkAggregatorAbi } from "../config/abis.js";
import { formatFixed } from "../lib/units.js";
import { v3PoolAbi, UNISWAP_RECORDED_ONLY } from "../protocols/uniswap/constants.js";
import { price0In1, price1In0 } from "../protocols/uniswap/math.js";
import { stateViewAbi } from "../protocols/uniswap/v4adapter.js";

export const POLL_MS = 2_000;
export const MAX_ASSETS_PER_STREAM = 12;
export const PAIRS_PER_ASSET = 8;

/** What the hub needs to know about a market (from the engine snapshot). */
export interface LiveMarket {
  id: string;
  venue: string; // "Uniswap v3" | "Uniswap v4" | "Ramses"
  kind: "V3" | "V4";
  /** Pool address (V3) or pool id (V4). */
  target: string;
  feePpm: number | null;
  tvlUsd: string | null;
  a0: { key: string; symbol: string; decimals: number };
  a1: { key: string; symbol: string; decimals: number };
}

export interface LiveFeed {
  key: string;
  symbol: string;
  proxy: Address;
  decimals: number;
}

export interface PairTick {
  id: string;
  venue: string;
  feePpm: number | null;
  tvlUsd: string | null;
  a0: { key: string; symbol: string };
  a1: { key: string; symbol: string };
  /** a1 per a0 and a0 per a1, decimal strings (18 places, trimmed). */
  price: string | null;
  inverse: string | null;
  block: string;
  t: string;
}

export interface PriceTick {
  key: string;
  symbol: string;
  usd: string;
  /** Feed's own update time (Chainlink updatedAt). */
  updatedAt: string;
  block: string;
}

export interface LiveSource {
  /** Most liquid markets of an asset (by TVL), for pairs. */
  marketsFor(assetKey: string, limit: number): Promise<LiveMarket[]>;
  /** The asset's Chainlink feed, if it has one. */
  feedFor(assetKey: string): Promise<LiveFeed | null>;
}

type Send = (event: "snapshot" | "pair" | "price" | "block", data: unknown) => void;

interface Sub {
  pairAssets: Set<string>;
  priceAssets: Set<string>;
  send: Send;
}

export class LiveHub {
  private readonly subs = new Set<Sub>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private readonly pairs = new Map<string, PairTick>();
  private readonly prices = new Map<string, PriceTick>();
  private readonly marketCache = new Map<string, { at: number; v: LiveMarket[] }>();
  private readonly feedCache = new Map<string, { at: number; v: LiveFeed | null }>();

  constructor(
    private readonly reader: Pick<ChainReader, "getLatestBlock" | "multicall">,
    private readonly source: LiveSource,
    private readonly opts: { pollMs?: number; now?: () => number } = {},
  ) {}

  get size(): number {
    return this.subs.size;
  }

  /** Registers a subscriber; returns the unsubscribe function. The first poll runs right away. */
  subscribe(q: { pairs: string[]; prices: string[] }, send: Send): () => void {
    const sub: Sub = { pairAssets: new Set(q.pairs.slice(0, MAX_ASSETS_PER_STREAM)), priceAssets: new Set([...q.prices, ...q.pairs].slice(0, MAX_ASSETS_PER_STREAM)), send };
    this.subs.add(sub);
    if (!this.timer) this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? POLL_MS);
    // Wait for any poll in progress, then run one that includes this subscriber's assets.
    void (this.inflight ?? Promise.resolve()).then(() => this.poll()).then(() => this.sendSnapshot(sub));
    return () => {
      this.subs.delete(sub);
      if (!this.subs.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
    };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.subs.clear();
  }

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  private async markets(asset: string): Promise<LiveMarket[]> {
    const hit = this.marketCache.get(asset);
    if (hit && this.now() - hit.at < 60_000) return hit.v;
    const v = await this.source.marketsFor(asset, PAIRS_PER_ASSET).catch(() => []);
    this.marketCache.set(asset, { at: this.now(), v });
    return v;
  }

  private async feed(asset: string): Promise<LiveFeed | null> {
    const hit = this.feedCache.get(asset);
    if (hit && this.now() - hit.at < 10 * 60_000) return hit.v;
    const v = await this.source.feedFor(asset).catch(() => null);
    this.feedCache.set(asset, { at: this.now(), v });
    return v;
  }

  private marketsOfSub(sub: Sub, all: Map<string, LiveMarket[]>): LiveMarket[] {
    return [...sub.pairAssets].flatMap((a) => all.get(a) ?? []);
  }

  private sendSnapshot(sub: Sub) {
    if (!this.subs.has(sub)) return;
    const pairIds = new Set([...sub.pairAssets].flatMap((a) => (this.marketCache.get(a)?.v ?? []).map((m) => m.id)));
    sub.send("snapshot", {
      pairs: [...this.pairs.values()].filter((p) => pairIds.has(p.id)),
      prices: [...this.prices.values()].filter((p) => sub.priceAssets.has(p.key)),
      pollMs: this.opts.pollMs ?? POLL_MS,
    });
  }

  /** One read of everything watched; broadcasts what changed. */
  poll(): Promise<void> {
    if (this.inflight || !this.subs.size) return this.inflight ?? Promise.resolve();
    this.inflight = this.read().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async read(): Promise<void> {
    try {
      const pairAssets = new Set([...this.subs].flatMap((s) => [...s.pairAssets]));
      const priceAssets = new Set([...this.subs].flatMap((s) => [...s.priceAssets]));
      const byAsset = new Map<string, LiveMarket[]>();
      for (const a of pairAssets) byAsset.set(a, await this.markets(a));
      const markets = [...new Map([...byAsset.values()].flat().map((m) => [m.id, m])).values()];
      const feeds = (await Promise.all([...priceAssets].map((a) => this.feed(a)))).filter((f): f is LiveFeed => !!f);
      if (!markets.length && !feeds.length) return;

      const block = (await this.reader.getLatestBlock()).number;
      const calls = [
        ...markets.map((m) =>
          m.kind === "V3"
            ? { address: m.target as Address, abi: v3PoolAbi, functionName: "slot0" }
            : { address: UNISWAP_RECORDED_ONLY.v4StateView as Address, abi: stateViewAbi, functionName: "getSlot0", args: [m.target as Hex] },
        ),
        ...feeds.map((f) => ({ address: f.proxy, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" })),
      ];
      const res = await this.reader.multicall(calls as never, { blockNumber: block });
      const t = new Date(this.now()).toISOString();
      const changedPairs: PairTick[] = [];
      markets.forEach((m, i) => {
        const r = res[i];
        if (r?.status !== "success") return;
        const sqrt = (r.result as readonly bigint[])[0]!;
        if (!sqrt) return;
        const p = price0In1(sqrt, m.a0.decimals, m.a1.decimals);
        const inv = price1In0(sqrt, m.a0.decimals, m.a1.decimals);
        const tick: PairTick = {
          id: m.id,
          venue: m.venue,
          feePpm: m.feePpm,
          tvlUsd: m.tvlUsd,
          a0: { key: m.a0.key, symbol: m.a0.symbol },
          a1: { key: m.a1.key, symbol: m.a1.symbol },
          price: p > 0n ? formatFixed(p, 18) : null,
          inverse: inv ? formatFixed(inv, 18) : null,
          block: block.toString(),
          t,
        };
        const prev = this.pairs.get(m.id);
        this.pairs.set(m.id, tick);
        if (!prev || prev.price !== tick.price) changedPairs.push(tick);
      });
      const changedPrices: PriceTick[] = [];
      feeds.forEach((f, j) => {
        const r = res[markets.length + j];
        if (r?.status !== "success") return;
        const row = r.result as readonly bigint[];
        if (!(row[1]! > 0n)) return;
        const tick: PriceTick = { key: f.key, symbol: f.symbol, usd: formatFixed(row[1]!, f.decimals), updatedAt: new Date(Number(row[3]!) * 1000).toISOString(), block: block.toString() };
        const prev = this.prices.get(f.key);
        this.prices.set(f.key, tick);
        if (!prev || prev.usd !== tick.usd || prev.updatedAt !== tick.updatedAt) changedPrices.push(tick);
      });
      for (const sub of this.subs) {
        // Heartbeat: the block just read, so clients can show the feed is live between changes.
        sub.send("block", { block: block.toString(), t });
        const mine = new Set(this.marketsOfSub(sub, byAsset).map((m) => m.id));
        for (const p of changedPairs) if (mine.has(p.id)) sub.send("pair", p);
        for (const p of changedPrices) if (sub.priceAssets.has(p.key)) sub.send("price", p);
      }
    } catch {
      /* transient RPC failure: next poll retries */
    }
  }
}
