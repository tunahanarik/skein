/**
 * Generic eligibility: derives reasons ONLY from canonical Opportunity fields (verification,
 * risk, lifecycle, entry, liquidity). Adapters describe facts; this layer applies policy.
 */
import { DEFAULT_ELIGIBILITY_POLICY, type EligibilityPolicy } from "@skein/core/config/eligibility";
import type { Eligibility, EligibilityReason, Opportunity } from "@skein/core/model/opportunity";
import { headlineMetric } from "./headline.js";

export function eligibilityReasons(o: Opportunity, policy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY): EligibilityReason[] {
  const r = new Set<EligibilityReason>();
  if (o.verificationStatus === "CONFLICT") r.add("DATA_CONFLICT");
  if (!o.risk.allAssetsCanonical) r.add("UNVERIFIED_ASSET");
  else if (o.verificationStatus === "UNVERIFIED" || o.verificationStatus === "THIRD_PARTY_ONLY") r.add("INSUFFICIENT_VERIFICATION");
  const lc = o.lifecycle;
  if (lc.state === "EXPIRED" || lc.blockers.includes("EXPIRED")) r.add("EXPIRED");
  if (lc.state === "INACTIVE" || lc.blockers.includes("MARKET_INACTIVE")) r.add("INACTIVE");
  if (lc.blockers.includes("DEPOSIT_DISABLED")) r.add("DEPOSIT_DISABLED");
  if (lc.blockers.includes("PROTOCOL_PAUSED")) r.add("PROTOCOL_PAUSED");
  if (lc.state === "UNKNOWN" || lc.canEnter === null || lc.blockers.includes("STATE_UNKNOWN")) r.add("ENTRY_STATE_UNKNOWN");
  if (o.entry.kind === "UNKNOWN") r.add("ENTRY_ROUTE_UNKNOWN");
  if (o.risk.protocolListed.known && o.risk.protocolListed.value === false) r.add("PROTOCOL_UNLISTED");
  const liq = o.availableLiquidity?.value;
  if (liq?.amount && liq.amount.raw === 0n) r.add("ZERO_LIQUIDITY");
  else if (liq?.usd && liq.usd.e18 < policy.lowLiquidityUsdE18) r.add("LOW_LIQUIDITY");
  // Venue size: the larger of TVL and available liquidity, when at least one is priced.
  const sizes = [o.tvl?.value.usd?.e18, liq?.usd?.e18].filter((v): v is bigint => v !== undefined && v !== null);
  if (sizes.length && sizes.reduce((a, b) => (a > b ? a : b)) < policy.dustLiquidityUsdE18) r.add("DUST_LIQUIDITY");
  // Category rule: a trade venue's size is its market TVL (both sides priced); one priced
  // reserve is not enough to show it is not dust.
  if (o.category === "TRADE" && !o.tvl?.value.usd) r.add("LIQUIDITY_UNVERIFIED");
  if (headlineMetric(o)?.semantics?.status === "UNRESOLVED") r.add("UNRESOLVED_YIELD_SEMANTICS");
  return [...r];
}

export function computeEligibility(o: Opportunity, policy: EligibilityPolicy = DEFAULT_ELIGIBILITY_POLICY): Eligibility {
  const reasons = eligibilityReasons(o, policy);
  const excludedBy = reasons.filter((x) => policy.excluding.includes(x));
  return { eligibleForDefaultDisplay: excludedBy.length === 0, excludedBy, advisories: reasons.filter((x) => !policy.excluding.includes(x)), policy: policy.id };
}

/**
 * Whether an opportunity is shown under a query. `includeReasons` re-admits opportunities whose
 * ONLY excluding reasons are in that list (e.g. include expired, include conflicted).
 */
export function passesEligibility(e: Eligibility, mode: "ELIGIBLE_ONLY" | "ALL", includeReasons: readonly EligibilityReason[] = []): boolean {
  if (mode === "ALL" || e.eligibleForDefaultDisplay) return true;
  return e.excludedBy.every((x) => includeReasons.includes(x));
}
