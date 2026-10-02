/**
 * Comparison semantics. Metrics are shown side by side only within a group, and RANKED only
 * when type, side and unit match. No scoring.
 *
 *   CAPITAL_YIELD_VARIABLE   SUPPLY_APY, BASE_APY, NET_APY (EARN) — floating return on deposited capital
 *   CAPITAL_YIELD_TO_MATURITY IMPLIED_APY, FIXED_APY — rate locked by buying at today's price and holding to maturity
 *   BORROW_COST              BORROW_APY, NET_APY (PAY) — cost, lower is cheaper
 *   LP_RETURN                LP_APR, and NET_APY on LP opportunities — composite, moves with pool composition
 *   YIELD_SPECULATION        YIELD_EXPOSURE_APY — depends on future realised yield; can be negative
 *   INCENTIVE                REWARD_APY — paid in reward tokens, can end any time
 *   REFERENCE                UNDERLYING_APY, COMPONENT_APY — context figures, not returns the user earns directly
 */
import type { Opportunity, YieldMetric } from "@skein/core/model/opportunity";

export type ComparisonGroup = "CAPITAL_YIELD_VARIABLE" | "CAPITAL_YIELD_TO_MATURITY" | "BORROW_COST" | "LP_RETURN" | "YIELD_SPECULATION" | "INCENTIVE" | "REFERENCE";

export function comparisonGroup(m: YieldMetric, category?: Opportunity["category"]): ComparisonGroup {
  switch (m.type) {
    case "SUPPLY_APY":
    case "BASE_APY":
      return "CAPITAL_YIELD_VARIABLE";
    case "NET_APY":
      return m.side === "PAY" ? "BORROW_COST" : category === "LP" ? "LP_RETURN" : "CAPITAL_YIELD_VARIABLE";
    case "IMPLIED_APY":
    case "FIXED_APY":
      return "CAPITAL_YIELD_TO_MATURITY";
    case "BORROW_APY":
      return "BORROW_COST";
    case "LP_APR":
      return "LP_RETURN";
    case "YIELD_EXPOSURE_APY":
      return "YIELD_SPECULATION";
    case "REWARD_APY":
      return "INCENTIVE";
    case "UNDERLYING_APY":
    case "COMPONENT_APY":
      return "REFERENCE";
  }
}

export interface Comparability {
  /** Same group: may be displayed side by side. */
  displayTogether: boolean;
  /** Same type, side and unit: may be ranked against each other. */
  rankable: boolean;
  caveats: string[];
}

export function compareMetrics(a: { metric: YieldMetric; category: Opportunity["category"] }, b: { metric: YieldMetric; category: Opportunity["category"] }): Comparability {
  const ga = comparisonGroup(a.metric, a.category);
  const gb = comparisonGroup(b.metric, b.category);
  const caveats: string[] = [];
  const sameUnit = (a.metric.denominatedIn?.key ?? null) === (b.metric.denominatedIn?.key ?? null);
  if (!sameUnit) caveats.push(`denominated in different assets (${a.metric.denominatedIn?.symbol ?? "?"} vs ${b.metric.denominatedIn?.symbol ?? "?"})`);
  if (a.metric.basis !== b.metric.basis) caveats.push(`different basis (${a.metric.basis} vs ${b.metric.basis})`);
  if (ga !== gb) caveats.push(`different comparison groups (${ga} vs ${gb})`);
  return { displayTogether: ga === gb, rankable: a.metric.type === b.metric.type && a.metric.side === b.metric.side && sameUnit, caveats };
}
