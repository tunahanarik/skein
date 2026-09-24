/** Human wording for machine codes. Neutral: describes conditions, never recommends. */

export const USABILITY_LABEL: Record<string, string> = {
  ACTIONABLE: "Available",
  LIMITED: "Limited",
  INFORMATIONAL: "Info only",
  HIDDEN_BY_DEFAULT: "Hidden",
  UNAVAILABLE: "Unavailable",
};

export const REASON_TEXT: Record<string, string> = {
  DATA_CONFLICT: "Data sources disagree (e.g. an oracle applies the Stock Token multiplier twice).",
  NON_CANONICAL_ASSET: "Involves a token that is not in the verified asset registry.",
  INSUFFICIENT_VERIFICATION: "Not verified onchain well enough to show.",
  DUST_LIQUIDITY: "Liquidity below $50.",
  UNRESOLVED_YIELD_SEMANTICS: "The yield figure's meaning for Stock Tokens is not established.",
  LIQUIDITY_UNVERIFIED: "Liquidity could not be valued.",
  ENTRY_ROUTE_UNKNOWN: "How to enter is not known.",
  ENTRY_STATE_UNKNOWN: "Whether it can be entered right now is not known.",
  EXTREME_PRICE_IMPACT: "Price impact of 15% or more for this amount.",
  EXPIRED: "Matured or expired.",
  INACTIVE: "Inactive.",
  DEPOSIT_DISABLED: "Deposits are disabled.",
  PROTOCOL_PAUSED: "The protocol is paused.",
  ZERO_BORROWABLE_LIQUIDITY: "Nothing can be borrowed right now (0 available).",
  LOW_LIQUIDITY: "Less than $10,000 of liquidity.",
  ZERO_LIQUIDITY: "No liquidity right now.",
  LOW_ROUTE_LIQUIDITY: "The thinnest pool on this route holds less than $10,000.",
  ELEVATED_PRICE_IMPACT: "Price impact between 1% and 5% for this amount.",
  HIGH_PRICE_IMPACT: "Price impact between 5% and 15% for this amount.",
  PRICE_IMPACT_UNKNOWN: "Price impact could not be computed.",
  STALE_DATA: "The headline figure is stale or of unknown age.",
  QUOTE_STALE: "The quote is more than 60 seconds old.",
};

export const NOTE_TEXT: Record<string, string> = {
  PROTOCOL_UNLISTED: "Not listed in the protocol's own app",
  ORACLE_ASSUMES_LOAN_PEG: "Oracle assumes the loan asset is worth $1",
  ACCOUNTING_UNIT_NOT_TOKEN: "Rate is in shares, not tokens",
  IMPLIED_RATE_NOT_GUARANTEED: "Implied rate, not guaranteed",
  UNDERLYING_UNVERIFIED: "Part of the yield is not verifiable onchain",
  YIELD_TOKEN_DECAYS_TO_ZERO: "YT value goes to zero at maturity",
  RESERVES_INCLUDE_UNCOLLECTED_FEES: "Reserves include uncollected fees",
  MARKET_PRICE_DIVERGENCE: "Pool price differs from the reference price",
  REWARDS_MAY_BE_INCOMPLETE: "External rewards may be missing",
  VOLUME_UNKNOWN: "24h volume not measured",
};

export const CATEGORY_TEXT: Record<string, { title: string; blurb: string }> = {
  TRADE: { title: "Trade", blurb: "Swap into another asset through verified pools." },
  EARN: { title: "Earn", blurb: "Lend, deposit, or lock in a rate to maturity." },
  BORROW: { title: "Borrow", blurb: "Use this asset as collateral to borrow another." },
  LIQUIDITY: { title: "Liquidity", blurb: "Provide liquidity to a pool and earn its fees and rewards." },
};

export const SUB_TEXT: Record<string, string> = {
  TRADE: "Routes",
  LEND: "Lend",
  VAULT: "Vaults",
  FIXED_YIELD: "Fixed rate (PT)",
  YIELD: "Yield tokens (YT)",
  COLLATERAL: "Borrow against",
  LP: "Liquidity pools",
};

export const COMPARATOR_TEXT: Record<string, string> = {
  TRADE_ROUTE_V1: "Ordered by availability, then pool liquidity, fewer hops, lower fee.",
  TRADE_QUOTE_V1: "Ordered by availability, then expected output for your amount.",
  LEND_V1: "Ordered by availability, then supply APY, then liquidity.",
  VAULT_V1: "Ordered by availability, then net APY, then TVL.",
  FIXED_YIELD_V1: "Ordered by availability, then implied APY (same unit only), then liquidity.",
  YIELD_V1: "Ordered by availability, then liquidity. Never by the speculative YT APY.",
  LP_V1: "Ordered by availability, then net APY, then liquidity.",
  COLLATERAL_V1: "Grouped by the asset you borrow, then lower borrow APY, then available liquidity.",
};

export const EMPTY_TEXT: Record<string, string> = {
  UNKNOWN_ASSET: "This asset is not in the verified registry.",
  NON_CANONICAL_ASSET: "This token is not a verified Robinhood Chain asset.",
  UNPRICED: "No price is available for this asset right now.",
  NO_OPPORTUNITIES: "No protocol we cover offers anything for this asset yet.",
  NO_USABLE_OPPORTUNITIES: "Opportunities exist, but none pass the default checks. Turn on “Show hidden” to see why.",
  ADAPTERS_UNAVAILABLE: "Protocol data is unavailable right now.",
};

export const QUALITY_TEXT: Record<string, string> = {
  COMPLETE: "All sources answered",
  PARTIAL: "Some sources did not answer",
  STALE: "Some figures are stale",
  UNKNOWN: "Data unavailable",
};

export const TYPE_TEXT: Record<string, string> = {
  STOCK_TOKEN: "Stock Token",
  STABLECOIN: "Stablecoin",
  WRAPPED_NATIVE: "Wrapped ETH",
  NATIVE: "Native",
  ERC20: "Token",
};
