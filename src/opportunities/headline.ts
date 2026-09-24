/**
 * The headline (reference) yield metric per category — category semantics, not protocol logic.
 * Shared by user context and eligibility so both agree on "the number the user looks at".
 */
import type { Opportunity, OpportunityCategory, YieldMetric, YieldMetricType } from "../model/opportunity.js";

export const HEADLINE_METRIC: Partial<Record<OpportunityCategory, YieldMetricType[]>> = {
  LEND: ["SUPPLY_APY", "NET_APY"],
  VAULT: ["NET_APY", "SUPPLY_APY", "BASE_APY"],
  COLLATERAL: ["BORROW_APY", "NET_APY"],
  FIXED_YIELD: ["IMPLIED_APY", "FIXED_APY"],
  YIELD: ["YIELD_EXPOSURE_APY", "NET_APY"],
  LP: ["NET_APY", "LP_APR"],
};

export function headlineMetric(o: Pick<Opportunity, "category" | "yields">): YieldMetric | null {
  const wanted = HEADLINE_METRIC[o.category] ?? [];
  return wanted.map((t) => o.yields.find((y) => y.type === t)).find((y) => !!y) ?? null;
}
