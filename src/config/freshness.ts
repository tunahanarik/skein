/**
 * Centralized freshness and conflict policy. No other file may hardcode an age threshold.
 *
 * Classification of an age (seconds since the SOURCE's own timestamp, not our fetch time):
 *   age ≤ freshMaxSeconds  → FRESH
 *   age ≤ agingMaxSeconds  → AGING   (usable; lower confidence)
 *   age >  agingMaxSeconds → STALE   (not used as a current price)
 *   no/invalid/future ts   → UNKNOWN (not used)
 * "HEARTBEAT" means the feed's own heartbeat from the Chainlink directory.
 */
export type FreshnessStatus = "FRESH" | "AGING" | "STALE" | "UNKNOWN";

export interface FreshnessRule {
  freshMaxSeconds: number | "HEARTBEAT";
  agingMaxSeconds: number | "HEARTBEAT" | "HEARTBEAT_PLUS_1H";
  /** Why these numbers (shown in docs/pricing.md). */
  rationale: string;
}

export const FRESHNESS_RULES = {
  /**
   * Chainlink Stock Token feeds: heartbeat 86,400 s, deviation 0.5 %, 24/5, and they hold the
   * last price while markets are closed. Within the heartbeat the feed is valid by design;
   * older than one hour it is still valid but we lower confidence.
   */
  CHAINLINK_STOCK_FEED: {
    freshMaxSeconds: 3_600,
    agingMaxSeconds: "HEARTBEAT",
    rationale: "valid within heartbeat by Chainlink design; >1h lowers confidence",
  },
  /** ETH/USD: same feed parameters (86,400 s / 0.5 %), 24/7 market. */
  CHAINLINK_ETH_USD: {
    freshMaxSeconds: 3_600,
    agingMaxSeconds: "HEARTBEAT",
    rationale: "24/7 asset; a quiet hour is normal, a missed heartbeat is not",
  },
  /** USDG/USD: a stable asset rarely moves 0.5 %, so hours-old answers are expected. */
  CHAINLINK_USDG_USD: {
    freshMaxSeconds: "HEARTBEAT",
    agingMaxSeconds: "HEARTBEAT_PLUS_1H",
    rationale: "updates on 0.5% deviation or 24h heartbeat; 1h grace for keeper latency",
  },
  /** Robinhood /rhj/prices: 15 s server cache per docs; `generatedAt` is the quote time. */
  ROBINHOOD_QUOTE: {
    freshMaxSeconds: 60,
    agingMaxSeconds: 900,
    rationale: "docs: 15 s cache; older than 15 min is not a current quote",
  },
  /**
   * Values we read onchain at the opportunity block (Morpho totals, oracle price, vault
   * totalAssets). Age = now − block timestamp.
   */
  ONCHAIN_STATE: {
    freshMaxSeconds: 60,
    agingMaxSeconds: 600,
    rationale: "read at our own pinned block; older means the block itself is old",
  },
  /**
   * Morpho market identity (loan/collateral/oracle/IRM/LLTV). Immutable per market once
   * created (docs: LLTV is "fixed, immutable"), so age only reflects when we last listed markets.
   */
  PROTOCOL_MARKET_CONFIG: {
    freshMaxSeconds: 3_600,
    agingMaxSeconds: 86_400,
    rationale: "immutable parameters; the list itself changes when markets are created",
  },
  /**
   * Morpho API market state (APY, rewards, utilization as indexed). `state.timestamp` is the
   * last indexed state; idle markets legitimately lag (tens of minutes observed 2026-09-24),
   * and AdaptiveCurveIRM rates drift slowly with time, so hours-old state is AGING, not wrong.
   */
  PROTOCOL_API_MARKET_STATE: {
    freshMaxSeconds: 3_600,
    agingMaxSeconds: 21_600,
    rationale: "indexed state lags on idle markets; rates drift slowly between interactions",
  },
  /** Robinhood /rhj/assets registry (live fetch or local snapshot). */
  ASSET_REGISTRY: {
    freshMaxSeconds: 900,
    agingMaxSeconds: 86_400,
    rationale: "listings change rarely; a day-old snapshot is still usable with a warning",
  },
} as const satisfies Record<string, FreshnessRule>;

export type FreshnessRuleId = keyof typeof FRESHNESS_RULES;

/** Tolerated clock skew before a future timestamp is treated as UNKNOWN. */
export const FUTURE_SKEW_TOLERANCE_SECONDS = 60;

/**
 * Chainlink Stock Token feed vs Robinhood quote (both as TOKEN prices). Feed deviation
 * threshold is 0.5 % and the quote is a bid/ask mid, so disagreement up to ~0.5 % is normal
 * (observed max 0.41 % on 2026-09-24). Above 1 % we flag PRICE_CONFLICT.
 */
export const STOCK_PRICE_CONFLICT_PCT = 1.0;

/** USDG depeg warning above this deviation from $1 (the feed's own 0.5 % threshold). */
export const USDG_PEG_WARNING_BPS = 50;

/** Cache TTLs (ms). Balances are never cached; failures are never cached. */
export const CACHE_TTL_MS = {
  ASSET_REGISTRY: 5 * 60_000,
  CHAINLINK_DIRECTORY: 60 * 60_000,
  ROBINHOOD_QUOTES: 15_000,
  /** Market list + onchain-verified immutable params: slow-changing configuration. */
  PROTOCOL_MARKET_CONFIG: 60 * 60_000,
  /** Protocol API state (APY, rewards, vault figures): fast-changing. */
  PROTOCOL_MARKET_STATE: 60_000,
  /** Longest we will serve a last-good protocol state after a failed refresh (marked degraded). */
  PROTOCOL_STATE_STALE_FALLBACK: 6 * 60 * 60_000,
} as const;

/**
 * Morpho API totals are indexed at an earlier block than our onchain read; interest accrual and
 * new deposits move them. Beyond this relative gap the difference is recorded as DATA_CONFLICT
 * (onchain value kept, both values surfaced).
 */
export const PROTOCOL_TOTALS_CONFLICT_PCT = 2;
/**
 * Oracle structure match tolerance, parts per million. The oracles and our Price Service read the
 * same Chainlink feeds, so a matching structure agrees to ~1e-17 (observed 2026-09-24); 1 ppm is
 * generous yet still separates a multiplier of 1.00019 (190 ppm) from 1.
 */
export const ORACLE_MATCH_TOLERANCE_PPM = 1;
/** Beyond this, an oracle price is reported as deviating from our independent price. */
export const ORACLE_DEVIATION_WARNING_PCT = 2;

export function resolveLimit(v: number | "HEARTBEAT" | "HEARTBEAT_PLUS_1H", heartbeatSeconds: number | null): number | null {
  if (typeof v === "number") return v;
  if (heartbeatSeconds === null) return null;
  return v === "HEARTBEAT" ? heartbeatSeconds : heartbeatSeconds + 3_600;
}

export interface FreshnessInfo {
  status: FreshnessStatus;
  ageSeconds: number | null;
  rule: FreshnessRuleId;
}

/** Classify a source timestamp (unix seconds) against a rule at `nowSeconds`. */
export function classifyFreshness(
  rule: FreshnessRuleId,
  sourceTimestampSeconds: number | null,
  nowSeconds: number,
  heartbeatSeconds: number | null = null,
): FreshnessInfo {
  if (sourceTimestampSeconds === null || !Number.isFinite(sourceTimestampSeconds) || sourceTimestampSeconds <= 0) {
    return { status: "UNKNOWN", ageSeconds: null, rule };
  }
  const age = nowSeconds - sourceTimestampSeconds;
  if (age < -FUTURE_SKEW_TOLERANCE_SECONDS) return { status: "UNKNOWN", ageSeconds: age, rule };
  const r = FRESHNESS_RULES[rule] as FreshnessRule;
  const fresh = resolveLimit(r.freshMaxSeconds, heartbeatSeconds);
  const aging = resolveLimit(r.agingMaxSeconds, heartbeatSeconds);
  if (fresh === null || aging === null) return { status: "UNKNOWN", ageSeconds: Math.max(age, 0), rule };
  const a = Math.max(age, 0);
  return { status: a <= fresh ? "FRESH" : a <= aging ? "AGING" : "STALE", ageSeconds: a, rule };
}
