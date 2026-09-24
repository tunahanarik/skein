/**
 * Default user-facing eligibility policy. Discovery keeps everything; this policy only decides
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
  ],
  // A display hint, not a safety threshold: under $10k a single mid-size entry moves the market.
  lowLiquidityUsdE18: 10_000n * 10n ** 18n,
};
