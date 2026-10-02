/**
 * Generic, protocol-independent trade model (Phase 4). Three separate concepts:
 *
 *   TradeMarket  a liquidity venue for an asset pair (e.g. one NVDA/USDG pool). No amount.
 *   TradeRoute   a path from an input asset to an output asset through 1–2 markets. No amount.
 *   TradeQuote   an amount-specific INDICATIVE estimate for one route at one block.
 *
 * Nothing here is executable: no calldata, no minimum output, no deadline, no slippage limit.
 * Venue-specific data stays in `TradeMarket.details` (opaque to the engine and the router).
 */
import type { Address } from "viem";
import type { FreshnessInfo } from "../config/freshness.js";
import type { Fixed18 } from "../lib/fixed.js";
import type { AmountWithUsd, AssetRef, DataConflict, Measured, TokenAmount, UsdAmount } from "./opportunity.js";
import type { DataSource } from "./provenance.js";
import type { VerificationStatus } from "./verification.js";
import type { Warning } from "./warnings.js";

/**
 * Price kinds are never interchangeable:
 *   PORTFOLIO_PRICE   Phase 1 Price Service (authoritative for valuation)
 *   DEX_MARKET_PRICE  a venue's spot price; for trade discovery, routing and cross-checks only
 */
export type PriceKind = "PORTFOLIO_PRICE" | "DEX_MARKET_PRICE";

/** Spot price of `base` in units of `quote` (human units, 1e18-scaled). */
export interface MarketPrice {
  kind: "DEX_MARKET_PRICE";
  base: AssetRef;
  quote: AssetRef;
  /** quote units per 1 base unit, 1e18-scaled, exact from the venue's state (floor). */
  value: Measured<Fixed18>;
}

/**
 * Fee in parts per million of the input amount (Uniswap "hundredths of a bip").
 * DYNAMIC = set per swap by the venue (e.g. a hook); the value is then null.
 */
export interface TradeFee {
  ppm: number | null;
  kind: "STATIC" | "DYNAMIC";
}

/**
 * Liquidity is reported as separate, typed quantities — never one universal number.
 *   tvl              value of the tokens the market holds (both sides priced, else null)
 *   reserves         per-token amounts held by the market (balances / reserves), with USD
 *   activeLiquidity  venue-native in-range liquidity (e.g. Uniswap v3 `liquidity()`); not a USD figure
 *   depth            output of an actual read-only quote at a probe size, if measured
 * TVL is not executable depth: concentrated liquidity can hold large TVL out of range.
 */
export interface TradeLiquidity {
  tvl: Measured<UsdAmount> | null;
  reserves: Measured<AmountWithUsd>[];
  activeLiquidity: Measured<bigint> | null;
  activeLiquidityMeaning: string | null;
}

export type MarketState = "ACTIVE" | "NO_ACTIVE_LIQUIDITY" | "UNINITIALIZED" | "UNREADABLE";

export interface TradeMarket {
  /** `${chainId}:${protocolId}:${venueKind}:${marketId}` */
  id: string;
  chainId: number;
  protocol: { id: string; name: string };
  venueKind: string;
  /** Pool address, or pool id for singleton venues. */
  marketId: string;
  address: Address | null;
  /** In the venue's own order (e.g. token0, token1). Identity by address. */
  assets: [AssetRef, AssetRef];
  fee: Measured<TradeFee> | null;
  /** Spot price of assets[0] in assets[1] (and its inverse). */
  price: MarketPrice | null;
  priceInverse: MarketPrice | null;
  liquidity: TradeLiquidity;
  state: MarketState;
  /**
   * 24h volume (decision P4-5): UNKNOWN unless a verified source exists. Swap-log indexing is not
   * implemented, so it is always UNKNOWN today — never estimated, never 0.
   */
  volume24h: { status: "UNKNOWN"; reason: string };
  /** How the market's origin was established (e.g. factory event + factory getPool). */
  originVerified: boolean;
  verificationStatus: VerificationStatus;
  provenance: DataSource[];
  conflicts: DataConflict[];
  warnings: Warning[];
  freshness: FreshnessInfo;
  /** Venue-specific payload; the engine and the router never read it. */
  details: Record<string, unknown>;
}

export type RouteKind = "DIRECT" | "ONE_HOP";

export interface TradeHop {
  marketId: string;
  from: AssetRef;
  to: AssetRef;
  fee: TradeFee | null;
}

/**
 * Deterministic route ordering objective. Stated explicitly; nothing is "best".
 *   BOTTLENECK_TVL_DESC  highest minimum market TVL along the route first, then fewer hops,
 *                        then lower combined fee, then id
 */
export type RouteOrdering = "BOTTLENECK_TVL_DESC";

export interface TradeRoute {
  /** `${input}>${marketIds joined by '>'}>${output}` */
  id: string;
  input: AssetRef;
  output: AssetRef;
  kind: RouteKind;
  hops: TradeHop[];
  intermediates: AssetRef[];
  /** Objective properties only. */
  properties: {
    hopCount: number;
    /** 1 − Π(1 − fee_i), ppm; null if any hop's fee is dynamic/unknown. */
    combinedFeePpm: number | null;
    /** Smallest market TVL along the route (the bottleneck); null if any is unknown. */
    bottleneckTvlUsd: UsdAmount | null;
    allMarketsVerified: boolean;
    allAssetsCanonical: boolean;
    /** Venues involved (a single-venue route can be quoted by that venue). */
    protocols: string[];
  };
}

export type QuoteKind = "INDICATIVE_QUOTE";

/**
 * An amount-specific, read-only estimate. NOT a guaranteed output: the state can change before
 * any execution, and there is deliberately no minimum output (that needs a user-chosen slippage
 * in a future execution phase).
 */
export interface TradeQuote {
  kind: QuoteKind;
  routeId: string;
  input: TokenAmount & { asset: AssetRef };
  expectedOutput: TokenAmount & { asset: AssetRef };
  /** output units per 1 input unit, 1e18 (amountOut / amountIn in human units). */
  effectivePrice: Fixed18;
  /** Venue fees along the route, in the input asset of each hop, when determinable. */
  fees: { hop: number; asset: AssetRef; amount: TokenAmount }[] | null;
  /**
   * 1 − amountOut / (amountIn × Π spotPrice_i × Π(1 − fee_i)), 1e18. Price movement caused by
   * the trade itself, fees excluded, measured by the venue's own swap simulation. Null when a
   * spot price or fee is unknown.
   */
  priceImpact: Fixed18 | null;
  /** Venue-reported execution gas estimate (units), informational only; null if none. */
  gasEstimate: bigint | null;
  quotedAt: string;
  blockNumber: bigint;
  freshness: FreshnessInfo;
  source: DataSource;
  verification: VerificationStatus;
  warnings: Warning[];
}

export type QuoteResult = { ok: true; quote: TradeQuote } | { ok: false; reason: string; retryable: boolean };
