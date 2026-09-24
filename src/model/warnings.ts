/**
 * Machine-readable warning codes. Code elsewhere may only emit these — no free-form warning
 * strings. `message` is for humans; clients switch on `code`.
 */
export const WARNING_CODES = {
  // pricing
  STALE_PRICE: "WARNING",
  AGING_PRICE: "INFO",
  PRICE_CONFLICT: "WARNING",
  PRICE_FALLBACK_USED: "INFO",
  NO_CHAINLINK_FEED: "INFO",
  INVALID_FEED_ROUND: "WARNING",
  UNPRICED_ASSET: "WARNING",
  TRADING_HALTED: "WARNING",
  QUOTES_UNAVAILABLE: "WARNING",
  FEED_DIRECTORY_UNAVAILABLE: "WARNING",
  USDG_PEG_DEVIATION: "WARNING",
  // balances / multiplier
  BALANCE_READ_FAILED: "ERROR",
  MULTIPLIER_UNAVAILABLE: "WARNING",
  MULTIPLIER_FROM_REGISTRY: "INFO",
  REGISTRY_MULTIPLIER_MISMATCH: "INFO",
  PENDING_MULTIPLIER: "INFO",
  // registry
  REGISTRY_STALE: "WARNING",
  REGISTRY_SNAPSHOT_MODE: "WARNING",
  REGISTRY_CONFLICT: "ERROR",
  REGISTRY_ISSUE: "WARNING",
  REGISTRY_CHANGED: "INFO",
  // assets
  UNKNOWN_ASSET: "WARNING",
  LOOKALIKE_TOKEN: "ERROR",
  UNKNOWN_METADATA_UNREADABLE: "WARNING",
  // opportunities (Phase 2)
  DATA_CONFLICT: "WARNING",
  NON_CANONICAL_ASSET: "WARNING",
  ORACLE_MULTIPLIER_DOUBLE_APPLIED: "ERROR",
  ORACLE_PRICE_DEVIATION: "WARNING",
  ORACLE_INCONCLUSIVE: "WARNING",
  ORACLE_ASSUMES_LOAN_PEG: "INFO",
  ORACLE_UNREADABLE: "WARNING",
  MARKET_SKIPPED: "INFO",
  MARKET_UNVERIFIED_ONCHAIN: "WARNING",
  DUPLICATE_MARKET: "WARNING",
  DUPLICATE_OPPORTUNITY_ID: "WARNING",
  ADAPTER_FAILED: "ERROR",
  ADAPTER_DEGRADED: "WARNING",
  STALE_PROTOCOL_DATA: "WARNING",
  REWARDS_MAY_BE_INCOMPLETE: "INFO",
  PROTOCOL_WARNING: "WARNING",
  UNLISTED_MARKET: "INFO",
  ZERO_LIQUIDITY: "INFO",
  FULL_UTILIZATION: "WARNING",
  UNPRICED_METRIC: "INFO",
  POSITION_UNVERIFIED: "WARNING",
  // maturity markets / eligibility (Phase 3)
  EXPIRED_MARKET: "INFO",
  LOW_LIQUIDITY: "INFO",
  UNDERLYING_UNVERIFIED: "WARNING",
  UNDERLYING_YIELD_SOURCE_UNCLEAR: "WARNING",
  ENTRY_ROUTE_UNKNOWN: "WARNING",
  PROTOCOL_PAUSED: "WARNING",
  YIELD_TOKEN_DECAYS_TO_ZERO: "INFO",
  IMPLIED_RATE_NOT_GUARANTEED: "INFO",
  ACCOUNTING_UNIT_NOT_TOKEN: "INFO",
  MARKET_DISCOVERY_DEGRADED: "WARNING",
  // trade (Phase 4)
  MARKET_PRICE_DIVERGENCE: "WARNING",
  NO_ACTIVE_LIQUIDITY: "INFO",
  POOL_UNVERIFIED: "WARNING",
  INDICATIVE_QUOTE: "INFO",
  RESERVES_INCLUDE_UNCOLLECTED_FEES: "INFO",
  // infrastructure
  RPC_DEGRADED: "WARNING",
  PUBLIC_RPC_IN_USE: "INFO",
} as const;

export type WarningCode = keyof typeof WARNING_CODES;
export type WarningSeverity = (typeof WARNING_CODES)[WarningCode];

export interface Warning {
  code: WarningCode;
  severity: WarningSeverity;
  /** Asset key when the warning concerns one asset. */
  assetKey?: string;
  message: string;
  details?: Record<string, string | number | boolean | null>;
}

export function warn(code: WarningCode, message: string, extra: { assetKey?: string; details?: Warning["details"] } = {}): Warning {
  const w: Warning = { code, severity: WARNING_CODES[code], message };
  if (extra.assetKey !== undefined) w.assetKey = extra.assetKey;
  if (extra.details !== undefined) w.details = extra.details;
  return w;
}
