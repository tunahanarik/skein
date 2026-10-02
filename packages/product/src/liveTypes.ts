/**
 * Live price stream types, shared by the server (apps/server/src/live.ts, which implements the
 * SSE hub), the product service (which answers LiveSource) and the web client (which reads ticks).
 */
import type { Address } from "viem";

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
