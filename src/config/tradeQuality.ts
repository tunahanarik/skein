/**
 * Centralized trade-quality policy (Phase 5, decision P4-4).
 *
 * DISCOVERABLE vs USER_ACTIONABLE are different questions:
 *   - discovery keeps every verified, non-dust market as a routing edge (ROUTING_POLICY, $50);
 *   - user-facing route quality is judged by the QUOTE when an amount is given, and by route
 *     liquidity when it is not. The global dust threshold is deliberately not raised.
 *
 * PRICE-IMPACT CLASSES (fees excluded; `TradeQuote.priceImpact`). Boundaries follow the Uniswap
 * web interface's own warning levels, read from the official source on 2026-09-24:
 *   https://github.com/Uniswap/interface/blob/main/apps/web/src/constants/misc.ts
 *   ALLOWED_PRICE_IMPACT_LOW 1% · ALLOWED_PRICE_IMPACT_MEDIUM 3% · ALLOWED_PRICE_IMPACT_HIGH 5% ·
 *   BLOCKED_PRICE_IMPACT_NON_EXPERT 15% ("for non expert mode disable swaps above this")
 *
 *   LOW       impact <  1 %            ACTIONABLE
 *   ELEVATED  1 %  ≤ impact <  5 %     LIMITED (ELEVATED_PRICE_IMPACT)
 *   HIGH      5 %  ≤ impact < 15 %     LIMITED (HIGH_PRICE_IMPACT)
 *   EXTREME   impact ≥ 15 %            HIDDEN_BY_DEFAULT (EXTREME_PRICE_IMPACT) — the level at which
 *                                      the Uniswap interface itself blocks non-expert users
 *   UNKNOWN   impact not computable    LIMITED (PRICE_IMPACT_UNKNOWN)
 *
 * ROUTE LIQUIDITY without an amount: a route whose bottleneck TVL is below
 * `minActionableRouteTvlUsdE18` is LIMITED (LOW_ROUTE_LIQUIDITY). $10,000 = the existing
 * LOW_LIQUIDITY advisory line, so no new number is introduced. The observed ~$83 NVDA/USDG pool
 * (≈ 60 % impact for 1 NVDA) is LIMITED without an amount and EXTREME (hidden) with one.
 */
import { DEFAULT_ELIGIBILITY_POLICY } from "./eligibility.js";

export type PriceImpactClass = "LOW" | "ELEVATED" | "HIGH" | "EXTREME" | "UNKNOWN";

export interface TradeQualityPolicy {
  id: string;
  /** Upper bounds (exclusive), 1e18-scaled fractions. */
  lowBelowE18: bigint;
  elevatedBelowE18: bigint;
  highBelowE18: bigint;
  minActionableRouteTvlUsdE18: bigint;
  /** Max age of a quote's block timestamp for it to count as current (seconds). */
  maxQuoteAgeSeconds: number;
  source: string;
}

const pct = (n: bigint) => (n * 10n ** 18n) / 100n;

export const TRADE_QUALITY_POLICY: TradeQualityPolicy = {
  id: "trade-quality-v1",
  lowBelowE18: pct(1n),
  elevatedBelowE18: pct(5n),
  highBelowE18: pct(15n),
  minActionableRouteTvlUsdE18: DEFAULT_ELIGIBILITY_POLICY.lowLiquidityUsdE18,
  // ONCHAIN_STATE is FRESH ≤ 60 s; a quote older than that is re-requested, never shown as current.
  maxQuoteAgeSeconds: 60,
  source: "https://github.com/Uniswap/interface/blob/main/apps/web/src/constants/misc.ts",
};

export function classifyPriceImpact(impactE18: bigint | null, p: TradeQualityPolicy = TRADE_QUALITY_POLICY): PriceImpactClass {
  if (impactE18 === null) return "UNKNOWN";
  const v = impactE18 < 0n ? 0n : impactE18; // rounding can make it a hair negative
  if (v < p.lowBelowE18) return "LOW";
  if (v < p.elevatedBelowE18) return "ELEVATED";
  if (v < p.highBelowE18) return "HIGH";
  return "EXTREME";
}
