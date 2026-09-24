/**
 * Default user-facing eligibility policy.
 * PROTOCOL_UNLISTED is deliberately NOT excluding (P3-3): a market discovered from official
 * factory logs, verified onchain, liquid, not paused and not expired stays visible even if the
 * protocol's own app does not list it. Discovery keeps everything; this policy only decides
 * what the default view shows. Objective rules only — no risk judgement.
 * Phase 3 policy decisions (user-approved): conflicted, unverified-asset, deposit-disabled and
 * expired opportunities are excluded by default; a USDG-$1 oracle assumption is NOT a reason.
 */
import type { EligibilityReason } from "../model/opportunity.js";

export interface EligibilityPolicy {
  id: string;
  /** Reasons that remove an opportunity from the default view. */
  excluding: readonly EligibilityReason[];
  /** Below this USD liquidity an opportunity gets the advisory LOW_LIQUIDITY (1e18-scaled). */
  lowLiquidityUsdE18: bigint;
  /**
   * Below this USD venue size (max of TVL and available liquidity, both priced by the Phase 1
   * Price Service) an opportunity is DUST_LIQUIDITY. Unknown USD is never dust (not evaluable).
   */
  dustLiquidityUsdE18: bigint;
}

export const DEFAULT_ELIGIBILITY_POLICY: EligibilityPolicy = {
  id: "default-v1",
  excluding: [
    "DATA_CONFLICT",
    "UNVERIFIED_ASSET",
    "INSUFFICIENT_VERIFICATION",
    "EXPIRED",
    "INACTIVE",
    "DEPOSIT_DISABLED",
    "PROTOCOL_PAUSED",
    "ENTRY_STATE_UNKNOWN",
    "ENTRY_ROUTE_UNKNOWN",
    // Phase 4 policy decisions (user-approved):
    "UNRESOLVED_YIELD_SEMANTICS", // P3-1: e.g. Stock Token YT whose Pendle −100% may omit multiplier growth
    "DUST_LIQUIDITY", // P3-2: venue too small to be actionable
  ],
  // A display hint, not a safety threshold: under $10k a single mid-size entry moves the market.
  lowLiquidityUsdE18: 10_000n * 10n ** 18n,
  /*
   * $50. Chosen from the live distribution of venue sizes (2026-09-24, docs/opportunity-comparison.md):
   * 238 of 408 default opportunities are empty (< $1); curator seed deposits cluster at exactly
   * $1, $10, $25 and $100.01, so the threshold avoids those values. $50 is ~50× the $0.995 Pendle
   * dust market and ~1,000× below the $49.8k USDG market. Conservative: seeded $100 markets and
   * everything larger stay visible (with LOW_LIQUIDITY below $10k).
   */
  dustLiquidityUsdE18: 50n * 10n ** 18n,
};
