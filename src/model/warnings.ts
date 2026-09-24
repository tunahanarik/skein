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
