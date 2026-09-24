/**
 * A user's EXISTING position in a protocol. Kept separate from Opportunity: holding a position
 * is not an opportunity. Values follow the same Measured<T> provenance rules.
 */
import type { Address } from "viem";
import type { FreshnessInfo } from "../config/freshness.js";
import type { Fixed18 } from "../lib/fixed.js";
import type { AmountWithUsd, AssetRef, DataConflict, Measured } from "./opportunity.js";
import type { DataSource } from "./provenance.js";
import type { VerificationStatus } from "./verification.js";
import type { Warning } from "./warnings.js";

export interface Position {
  id: string; // `${chainId}:${protocolId}:position:${venueId}:${walletHash-free venue id}`
  chainId: number;
  protocol: { id: string; name: string };
  kind: "LENDING_MARKET" | "VAULT";
  venue: { kind: string; id: string; address: Address | null };
  /** The opportunity this position sits in, if the adapter knows it. */
  relatedOpportunityIds: string[];
  assets: AssetRef[];

  supplied: Measured<AmountWithUsd> | null;
  borrowed: Measured<AmountWithUsd> | null;
  collateral: Measured<AmountWithUsd> | null;
  /** Vault positions: share balance (raw) and its asset value. */
  shares: Measured<bigint> | null;

  /**
   * Lending positions, Morpho definition (docs /developers/borrow/concepts/ltv):
   * HF = collateral × oraclePrice / 1e36 × LLTV / borrowed. Computed by us from onchain values.
   * null when there is no debt (HF undefined) or inputs are missing.
   */
  healthFactor: Measured<Fixed18> | null;
  /** borrowed / (collateral × oraclePrice / 1e36), Fixed18; application-derived. */
  ltv: Measured<Fixed18> | null;
  /** Protocol rule evaluated with integer math at the pinned block; null when not evaluable. */
  liquidatable: boolean | null;

  provenance: DataSource[];
  conflicts: DataConflict[];
  warnings: Warning[];
  freshness: FreshnessInfo;
  verificationStatus: VerificationStatus;
}
