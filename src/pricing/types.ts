import type { Address } from "viem";
import type { FreshnessStatus } from "../config/freshness.js";
import type { DataSource, SourceType } from "../model/provenance.js";
import type { VerificationStatus } from "../model/verification.js";
import type { Warning } from "../model/warnings.js";
import type { PriceMethod } from "../registry/asset.js";

/** USD per ONE WHOLE TOKEN, fixed point. For Stock Tokens the multiplier is already inside. */
export interface UsdPrice {
  raw: bigint;
  decimals: number;
}

export type Confidence = "HIGH" | "MEDIUM" | "LOW";

export interface ChainlinkReading {
  proxy: Address;
  feedName: string;
  roundId: bigint;
  answer: bigint;
  decimals: number;
  updatedAt: number; // unix seconds (source timestamp)
  heartbeatSeconds: number;
  freshness: FreshnessStatus;
  ageSeconds: number | null;
  valid: boolean;
  invalidReason: string | null;
}

/** Robinhood /rhj/prices quote. bid/ask/mid are UNDERLYING share prices (no multiplier). */
export interface RobinhoodQuoteReading {
  symbol: string;
  bid: string;
  ask: string;
  underlyingMid: UsdPrice | null;
  spreadAbsolute: string | null; // USD per underlying share
  spreadBps: number | null; // (ask − bid) / mid × 10,000
  generatedAt: string;
  isTradingHalt: boolean;
  freshness: FreshnessStatus;
  ageSeconds: number | null;
  /** mid × uiMultiplier: the token price implied by the quote; null without a multiplier. */
  tokenMid: UsdPrice | null;
}

export interface CrossCheck {
  performed: boolean;
  reason: string | null; // why not performed
  /** |feed − quote-implied token price|, USD per token. */
  absoluteDifference: string | null;
  percentageDifference: number | null; // relative to the quote-implied price, in %
  thresholdPct: number;
  conflict: boolean;
}

export interface PriceQuote {
  assetKey: string;
  symbol: string;
  status: "PRICED" | "UNPRICED";
  priceUsd: UsdPrice | null;
  /** Decimal string of priceUsd for display. */
  priceUsdDisplay: string | null;
  method: PriceMethod | null;
  sourceType: SourceType | null;
  source: DataSource | null;
  /** Source timestamp of the selected price (Chainlink updatedAt / quote generatedAt). */
  observedAt: string | null;
  /** When we read it. */
  fetchedAt: string;
  ageSeconds: number | null;
  freshnessStatus: FreshnessStatus;
  confidence: Confidence | null;
  verificationStatus: VerificationStatus;
  chainlink: ChainlinkReading | null;
  robinhoodQuote: RobinhoodQuoteReading | null;
  crossCheck: CrossCheck | null;
  /** USDG only: (price − 1) × 10,000. */
  pegDeviationBps: number | null;
  unpricedReason: string | null;
  warnings: Warning[];
  /** Every source consulted, selected or not. */
  provenance: DataSource[];
}

/** Multiplier handed to the Price Service by the caller (read at the valuation block). */
export interface MultiplierInput {
  valueE18: bigint;
  source: "ONCHAIN" | "REGISTRY";
  provenance: DataSource;
}
