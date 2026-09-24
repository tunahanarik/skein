/**
 * Usability classification (docs/product-usability.md). Objective inputs only:
 *   the engine's eligibility (verification, asset identity, lifecycle, deposit status, dust,
 *   conflicts, entry route), liquidity, data freshness and — for amount-specific trades — the quote.
 * Separate from verification: a VERIFIED_ONCHAIN market can still be LIMITED.
 *
 * Status precedence (first match wins): HIDDEN_BY_DEFAULT > UNAVAILABLE > INFORMATIONAL > LIMITED
 * > ACTIONABLE. All reasons that apply are listed, not only the one that decided the status.
 */
import { DEFAULT_ELIGIBILITY_POLICY } from "../config/eligibility.js";
import { classifyPriceImpact, TRADE_QUALITY_POLICY, type PriceImpactClass } from "../config/tradeQuality.js";
import type { EligibilityReason, Opportunity } from "../model/opportunity.js";
import type { TradeQuote, TradeRoute } from "../model/trade.js";
import type { WarningCode } from "../model/warnings.js";
import { headlineMetric } from "../opportunities/headline.js";
import type { ProductNote, UsabilityReason, UsabilityResult } from "./types.js";

const HIDDEN: Partial<Record<EligibilityReason, UsabilityReason>> = {
  DATA_CONFLICT: "DATA_CONFLICT",
  UNVERIFIED_ASSET: "NON_CANONICAL_ASSET",
  INSUFFICIENT_VERIFICATION: "INSUFFICIENT_VERIFICATION",
  DUST_LIQUIDITY: "DUST_LIQUIDITY",
  UNRESOLVED_YIELD_SEMANTICS: "UNRESOLVED_YIELD_SEMANTICS",
  LIQUIDITY_UNVERIFIED: "LIQUIDITY_UNVERIFIED",
  ENTRY_ROUTE_UNKNOWN: "ENTRY_ROUTE_UNKNOWN",
  ENTRY_STATE_UNKNOWN: "ENTRY_STATE_UNKNOWN",
};
const UNAVAILABLE: Partial<Record<EligibilityReason, UsabilityReason>> = {
  EXPIRED: "EXPIRED",
  INACTIVE: "INACTIVE",
  DEPOSIT_DISABLED: "DEPOSIT_DISABLED",
  PROTOCOL_PAUSED: "PROTOCOL_PAUSED",
};
const NOTE_FROM_WARNING: Partial<Record<WarningCode, ProductNote>> = {
  UNLISTED_MARKET: "PROTOCOL_UNLISTED",
  ORACLE_ASSUMES_LOAN_PEG: "ORACLE_ASSUMES_LOAN_PEG",
  ACCOUNTING_UNIT_NOT_TOKEN: "ACCOUNTING_UNIT_NOT_TOKEN",
  IMPLIED_RATE_NOT_GUARANTEED: "IMPLIED_RATE_NOT_GUARANTEED",
  UNDERLYING_UNVERIFIED: "UNDERLYING_UNVERIFIED",
  YIELD_TOKEN_DECAYS_TO_ZERO: "YIELD_TOKEN_DECAYS_TO_ZERO",
  RESERVES_INCLUDE_UNCOLLECTED_FEES: "RESERVES_INCLUDE_UNCOLLECTED_FEES",
  MARKET_PRICE_DIVERGENCE: "MARKET_PRICE_DIVERGENCE",
  REWARDS_MAY_BE_INCOMPLETE: "REWARDS_MAY_BE_INCOMPLETE",
};

function decide(hidden: UsabilityReason[], unavailable: UsabilityReason[], informational: UsabilityReason[], limited: UsabilityReason[], notes: ProductNote[], policies: string[]): UsabilityResult {
  const reasons = [...hidden, ...unavailable, ...informational, ...limited];
  const status = hidden.length ? "HIDDEN_BY_DEFAULT" : unavailable.length ? "UNAVAILABLE" : informational.length ? "INFORMATIONAL" : limited.length ? "LIMITED" : "ACTIONABLE";
  return { status, reasons: [...new Set(reasons)], notes: [...new Set(notes)].sort(), policies };
}

/** Usability of a raw opportunity (no amount). */
export function classifyOpportunity(o: Opportunity): UsabilityResult {
  const e = o.eligibility;
  const hidden: UsabilityReason[] = [];
  const unavailable: UsabilityReason[] = [];
  const informational: UsabilityReason[] = [];
  const limited: UsabilityReason[] = [];
  for (const r of e?.excludedBy ?? []) {
    if (HIDDEN[r]) hidden.push(HIDDEN[r]!);
    else if (UNAVAILABLE[r]) unavailable.push(UNAVAILABLE[r]!);
  }
  const liqUsd = o.availableLiquidity?.value.usd?.e18 ?? null;
  const liqRaw = o.availableLiquidity?.value.amount?.raw ?? null;
  if (o.category === "COLLATERAL" && o.liquidityKind === "BORROWABLE" && liqRaw === 0n) informational.push("ZERO_BORROWABLE_LIQUIDITY");
  else if (e?.advisories.includes("ZERO_LIQUIDITY")) limited.push("ZERO_LIQUIDITY");
  if (o.category === "TRADE") {
    const tvl = o.tvl?.value.usd?.e18 ?? null;
    if (tvl !== null && tvl < TRADE_QUALITY_POLICY.minActionableRouteTvlUsdE18) limited.push("LOW_ROUTE_LIQUIDITY");
  } else if (e?.advisories.includes("LOW_LIQUIDITY") || (liqUsd !== null && liqUsd < DEFAULT_ELIGIBILITY_POLICY.lowLiquidityUsdE18 && liqRaw !== 0n)) {
    limited.push("LOW_LIQUIDITY");
  }
  // Stale or unknown-age headline data limits usability (a fresh balance does not fix it).
  const h = headlineMetric(o);
  if (h && (h.freshness.status === "STALE" || h.freshness.status === "UNKNOWN")) limited.push("STALE_DATA");
  const notes = o.warnings.map((w) => NOTE_FROM_WARNING[w.code]).filter((n): n is ProductNote => !!n);
  if (o.category === "TRADE") notes.push("VOLUME_UNKNOWN");
  return decide(hidden, unavailable, informational, limited, notes, [e?.policy ?? DEFAULT_ELIGIBILITY_POLICY.id]);
}

/** Usability of a trade route without an amount (route liquidity + market evidence). */
export function classifyRoute(route: TradeRoute): UsabilityResult {
  const limited: UsabilityReason[] = [];
  const hidden: UsabilityReason[] = [];
  if (!route.properties.allMarketsVerified) hidden.push("INSUFFICIENT_VERIFICATION");
  if (!route.properties.allAssetsCanonical) hidden.push("NON_CANONICAL_ASSET");
  const tvl = route.properties.bottleneckTvlUsd?.e18 ?? null;
  if (tvl === null) hidden.push("LIQUIDITY_UNVERIFIED");
  else if (tvl < TRADE_QUALITY_POLICY.minActionableRouteTvlUsdE18) limited.push("LOW_ROUTE_LIQUIDITY");
  return decide(hidden, [], [], limited, ["VOLUME_UNKNOWN"], [TRADE_QUALITY_POLICY.id]);
}

/**
 * Usability of a route FOR AN EXPLICIT AMOUNT: the quote's price-impact class and freshness are
 * added to the route's own evidence. A thin route (< $10k) stays LIMITED even when a small amount
 * shows low impact (P4-4: a tiny pool must never look normal).
 */
export function classifyQuotedRoute(route: TradeRoute, quote: TradeQuote, nowS: number, blockTimestampS: number): UsabilityResult & { impactClass: PriceImpactClass } {
  const base = classifyRoute(route);
  const hidden: UsabilityReason[] = base.reasons.filter((r) => r === "INSUFFICIENT_VERIFICATION" || r === "NON_CANONICAL_ASSET" || r === "LIQUIDITY_UNVERIFIED");
  const limited: UsabilityReason[] = base.reasons.filter((r) => r === "LOW_ROUTE_LIQUIDITY");
  const impactClass = classifyPriceImpact(quote.priceImpact);
  if (impactClass === "EXTREME") hidden.push("EXTREME_PRICE_IMPACT");
  else if (impactClass === "HIGH") limited.push("HIGH_PRICE_IMPACT");
  else if (impactClass === "ELEVATED") limited.push("ELEVATED_PRICE_IMPACT");
  else if (impactClass === "UNKNOWN") limited.push("PRICE_IMPACT_UNKNOWN");
  if (nowS - blockTimestampS > TRADE_QUALITY_POLICY.maxQuoteAgeSeconds) limited.push("QUOTE_STALE");
  return { ...decide(hidden, [], [], limited, base.notes, [TRADE_QUALITY_POLICY.id]), impactClass };
}

export const DEFAULT_VISIBLE: ReadonlySet<UsabilityResult["status"]> = new Set(["ACTIONABLE", "LIMITED", "INFORMATIONAL"]);
