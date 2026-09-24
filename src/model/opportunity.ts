/**
 * Canonical, protocol-independent opportunity model (Phase 2).
 *
 * Design rules:
 *  - Identity of an asset is `chainId:address` (AssetRef.key), never a symbol.
 *  - A missing value is `null` (with a reason where useful), never a fabricated 0.
 *  - Every measured value is a `Measured<T>`: value + origin + source + freshness + verification.
 *  - Yields are a LIST of explicitly typed metrics. Two metrics are comparable only if their
 *    type (and side) match — see YieldMetricType.
 *  - Protocol-specific data lives in `details` (discriminated union). The Opportunity Engine
 *    never reads `details`; only adapters and presentation code do.
 */
import type { Address, Hex } from "viem";
import type { FreshnessInfo } from "../config/freshness.js";
import type { Fixed18 } from "../lib/fixed.js";
import type { DataSource } from "./provenance.js";
import type { VerificationStatus } from "./verification.js";
import type { Warning } from "./warnings.js";
import type { AssetRelationship } from "./assetRelationship.js";

export const OPPORTUNITY_CATEGORIES = ["TRADE", "LEND", "BORROW", "COLLATERAL", "LP", "VAULT", "FIXED_YIELD", "YIELD"] as const;
export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];

/** Kept for Phase 0 config typing. */
export type AssetKind = "NATIVE" | "WRAPPED_NATIVE" | "STABLECOIN" | "STOCK_TOKEN" | "VAULT_SHARE" | "LP_TOKEN" | "OTHER";

export interface TrustedLink {
  url: string;
  host: string;
}

/** Reference to an asset as seen by an adapter, joined to the Phase 1 registry by address. */
export interface AssetRef {
  key: string; // `${chainId}:${lowercase address}`
  chainId: number;
  address: Address;
  /** Symbol as reported by the SOURCE (API/contract). Display only; may be a look-alike. */
  symbol: string;
  decimals: number;
  /** True only when the address is canonical in the Phase 1 Asset Registry. */
  canonical: boolean;
  /** Registry type when canonical ("STOCK_TOKEN", "STABLECOIN", …); null otherwise. */
  registryType: string | null;
}

/** A value with its full provenance and age. */
export interface Measured<T> {
  value: T;
  origin: "SUPPLIED" | "COMPUTED";
  source: DataSource;
  /** Source timestamp of the value (ISO), e.g. API state timestamp or block timestamp. */
  observedAt: string;
  freshness: FreshnessInfo;
  verification: VerificationStatus;
  /** For COMPUTED values: human-readable formula over named inputs. */
  formula?: string;
}

export interface TokenAmount {
  raw: bigint;
  decimals: number;
  display: string;
}

export interface UsdAmount {
  e18: bigint;
  display: string;
}

export interface AmountWithUsd {
  asset: AssetRef;
  /** null when the source gives only a USD figure (e.g. a protocol API TVL). */
  amount: TokenAmount | null;
  /** null when the asset could not be priced by the Phase 1 Price Service. */
  usd: UsdAmount | null;
}

// ---------------------------------------------------------------------------------------------
// Yield semantics
// ---------------------------------------------------------------------------------------------

/**
 * SUPPLY_APY   what a lender earns on supplied assets (variable, compounded)
 * BORROW_APY   what a borrower pays (variable, compounded) — a COST, not a return
 * BASE_APY     organic yield before incentives (e.g. vault APY excluding rewards)
 * REWARD_APY   incentive yield from reward tokens (APR or APY as the source defines — see compounding)
 * NET_APY      protocol-defined net figure (e.g. after fees and including rewards)
 * IMPLIED_APY  market-implied fixed rate (e.g. Pendle PT), valid only to maturity
 * FIXED_APY    contractually fixed rate
 * LP_APR       fee/incentive APR for liquidity provision (simple, not compounded)
 * UNDERLYING_APY      yield of the underlying asset itself, as the protocol measures it (a reference
 *                     figure, not something the user earns by entering the opportunity)
 * YIELD_EXPOSURE_APY  estimated annualized return of a yield-exposure position (e.g. Pendle YT) that
 *                     assumes the current underlying yield persists; can be negative, not a fixed rate
 * COMPONENT_APY       one component of a composite headline (see `componentOf`); never ranked alone
 */
export const YIELD_METRIC_TYPES = [
  "SUPPLY_APY",
  "BORROW_APY",
  "BASE_APY",
  "REWARD_APY",
  "NET_APY",
  "IMPLIED_APY",
  "FIXED_APY",
  "LP_APR",
  "UNDERLYING_APY",
  "YIELD_EXPOSURE_APY",
  "COMPONENT_APY",
] as const;
export type YieldMetricType = (typeof YIELD_METRIC_TYPES)[number];

export interface YieldMetric extends Measured<Fixed18> {
  type: YieldMetricType;
  /** EARN = user receives it; PAY = user pays it. Never rank EARN against PAY. */
  side: "EARN" | "PAY";
  basis: "VARIABLE" | "FIXED" | "IMPLIED";
  compounding: "COMPOUNDED" | "SIMPLE" | "UNKNOWN";
  /** Averaging window of the source ("instant", "1d", "7d"…). */
  window: string;
  /** Asset in which the yield accrues (matters for Pendle PT on Stock Tokens). */
  denominatedIn: AssetRef | null;
  /** REWARD_APY only: the reward token. */
  rewardAsset?: AssetRef | null;
  /** Human-readable label, e.g. "Morpho supply APY". */
  label: string;
  /** COMPONENT_APY only: the headline metric this is part of, and which part. */
  componentOf?: YieldMetricType | null;
  component?: string | null;
  /**
   * Phase 4: whether the METRIC'S MEANING is resolved. UNRESOLVED = the value is what the source
   * says, but we have measured evidence it may not describe what the user would earn (e.g. it may
   * omit a yield component) and cannot replace it with a verified figure. The value is never
   * rewritten; the flag drives the generic UNRESOLVED_YIELD_SEMANTICS eligibility reason.
   */
  semantics?: { status: "UNRESOLVED"; reason: string } | null;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle, entry and liquidity semantics (Phase 3)
// ---------------------------------------------------------------------------------------------

export type LifecycleState = "ACTIVE" | "EXPIRED" | "INACTIVE" | "UNKNOWN";
/** Why an opportunity cannot currently be entered. Adapters set these from protocol facts. */
export type EntryBlocker = "EXPIRED" | "DEPOSIT_DISABLED" | "MARKET_INACTIVE" | "PROTOCOL_PAUSED" | "STATE_UNKNOWN";

/**
 * Maturity is not a lock: a maturity-based position can usually be exited before maturity by
 * trading (at market price), while a lock forbids exit. Both are modelled separately.
 */
export interface Lifecycle {
  state: LifecycleState;
  /** Maturity timestamp (ISO) and its source; null for open-ended opportunities. */
  maturity: Measured<string> | null;
  /** maturity − reference time (seconds), from `timeReference`; negative once expired. */
  secondsToMaturity: number | null;
  /** Clock used for the comparison: the pinned block's timestamp. */
  timeReference: { kind: "BLOCK_TIMESTAMP"; blockNumber: bigint; timestamp: string } | null;
  canEnter: boolean | null;
  blockers: EntryBlocker[];
}

export type EntryKind = "DIRECT" | "SWAP_REQUIRED" | "WRAP_REQUIRED" | "SY_CONVERSION_REQUIRED" | "MULTI_STEP" | "UNKNOWN";

export interface EntryStep {
  action: "SUPPLY" | "POST_COLLATERAL" | "DEPOSIT" | "WRAP" | "SWAP" | "ADD_LIQUIDITY";
  from: AssetRef | null;
  to: AssetRef | null;
  /** Contract or venue performing the step. */
  venue: string;
  /** True only when the step's feasibility was checked (e.g. token ∈ SY.getTokensIn()). */
  verified: boolean;
  source: DataSource;
}

/**
 * What the holder of `requiredAsset` must do to enter. Descriptive only: this is not an
 * execution route and produces no calldata.
 */
export interface EntryRequirement {
  kind: EntryKind;
  requiredAsset: AssetRef;
  steps: EntryStep[];
  /** Whether one protocol call performs all steps (e.g. a router), with its evidence. */
  singleTransactionAvailable: Known<boolean>;
  note: string | null;
}

/**
 * What `availableLiquidity` measures. These are different quantities and are never compared:
 *   BORROWABLE           loan assets a borrower can take now (lending market)
 *   WITHDRAWABLE_SUPPLY  assets suppliers can withdraw now (supply − borrow)
 *   INSTANT_WITHDRAWAL   assets a vault can pay out immediately
 *   POOL_LIQUIDITY       value of the assets inside an AMM pool (e.g. Pendle PT + SY)
 */
export type LiquidityKind = "BORROWABLE" | "WITHDRAWABLE_SUPPLY" | "INSTANT_WITHDRAWAL" | "POOL_LIQUIDITY";

// ---------------------------------------------------------------------------------------------
// Eligibility (set by the Opportunity Engine, never by adapters)
// ---------------------------------------------------------------------------------------------

export type EligibilityReason =
  | "DATA_CONFLICT"
  | "UNVERIFIED_ASSET"
  | "INSUFFICIENT_VERIFICATION"
  | "EXPIRED"
  | "INACTIVE"
  | "DEPOSIT_DISABLED"
  | "PROTOCOL_PAUSED"
  | "ENTRY_STATE_UNKNOWN"
  | "ENTRY_ROUTE_UNKNOWN"
  | "PROTOCOL_UNLISTED"
  | "LOW_LIQUIDITY"
  | "ZERO_LIQUIDITY"
  // Phase 4 (policy P3-1 / P3-2)
  | "UNRESOLVED_YIELD_SEMANTICS"
  | "DUST_LIQUIDITY";

export interface Eligibility {
  /** Passes every excluding rule of the active policy. */
  eligibleForDefaultDisplay: boolean;
  /** Reasons that exclude it under the active policy. */
  excludedBy: EligibilityReason[];
  /** Reasons recorded but not excluding (advisory). */
  advisories: EligibilityReason[];
  policy: string;
}

// ---------------------------------------------------------------------------------------------
// Risk metadata (objective facts only; unknown is explicit)
// ---------------------------------------------------------------------------------------------

export type Known<T> = { known: true; value: T; source: DataSource } | { known: false; reason: string };

export interface OracleRisk {
  address: Address;
  /** Protocol-reported type (e.g. Morpho "ChainlinkOracleV2") or null. */
  reportedType: string | null;
  /**
   * Stock Token collateral only: our check of the oracle price against the Phase 1 Price
   * Service. DOUBLE_APPLIED = oracle/expected ratio equals uiMultiplier (Phase 0 finding).
   */
  multiplierCheck: "CONSISTENT" | "DOUBLE_APPLIED" | "DEVIATES" | "INCONCLUSIVE" | "NOT_DETECTABLE" | "NOT_APPLICABLE" | "UNCHECKED";
  multiplierCheckDetail: string | null;
  /** The oracle values the loan asset at exactly $1 instead of reading its price (ratio = loan USD price). */
  loanPegAssumed: boolean | null;
}

export interface OpportunityRisk {
  oracle: OracleRisk | null;
  lltv: Known<Fixed18>;
  utilization: Known<Fixed18>;
  availableLiquidityUsd: Known<UsdAmount>;
  marketSizeUsd: Known<UsdAmount>;
  /** Share of the headline EARN yield that comes from rewards (0–1e18). */
  rewardDependence: Known<Fixed18>;
  /** e.g. "LLTV, oracle, IRM and assets are immutable per Morpho market" */
  parameterMutability: Known<string>;
  /** Protocol's own curation signal (Morpho `listed`). */
  protocolListed: Known<boolean>;
  protocolWarnings: { type: string; level: string }[];
  allAssetsCanonical: boolean;
}

// ---------------------------------------------------------------------------------------------
// Opportunity
// ---------------------------------------------------------------------------------------------

export interface ContractRef {
  role: string;
  address: Address;
}

export interface LiquidationTerms {
  /** Liquidation LTV (Fixed18). */
  lltv: Measured<Fixed18>;
  /** Liquidation incentive factor (Fixed18, ≥ 1e18) if the protocol defines one. */
  liquidationIncentiveFactor: Measured<Fixed18> | null;
  /** Price source that decides liquidation (not our Price Service). */
  priceAuthority: string;
  /**
   * The protocol's own collateral→loan conversion at the pinned block, protocol-independent:
   *   loanBaseUnits = collateralBaseUnits × raw / scale
   * (Morpho: raw = oracle.price(), scale = 1e36). null when unreadable.
   */
  collateralPrice: Measured<{ raw: bigint; scale: bigint }> | null;
  /** Plain-language rule, e.g. "liquidatable when borrowed > collateral × oraclePrice / 1e36 × LLTV". */
  rule: string;
}

export interface DataConflict {
  field: string;
  values: { value: string; source: DataSource }[];
  resolution: string;
}

/** Protocol-specific payloads. Add a member per venue type; the engine ignores these. */
export type OpportunityDetails =
  | {
      kind: "MORPHO_MARKET";
      marketId: Hex;
      loanAsset: AssetRef;
      collateralAsset: AssetRef;
      oracle: Address;
      irm: Address;
      lltv: Fixed18;
      /** null when market(id) was unreadable — never a placeholder 0. */
      totalSupply: Measured<TokenAmount> | null;
      totalBorrow: Measured<TokenAmount> | null;
      oraclePrice: Measured<bigint> | null; // raw, scale 1e36 × 10^(loanDec − collDec)
    }
  | {
      kind: "PENDLE_MARKET";
      market: Address;
      /** Which Pendle position this opportunity is: buy PT, buy YT or provide LP. */
      position: "PT" | "YT" | "LP";
      pt: AssetRef;
      yt: AssetRef;
      sy: AssetRef;
      /** SY.yieldToken(): the token wrapped by SY. */
      yieldToken: AssetRef;
      /** SY.assetInfo() asset: what PT redeems into (1 PT = 1 accounting-asset unit at maturity). */
      accountingAsset: AssetRef | null;
      /**
       * What one accounting unit is. TOKEN: one token unit. LIQUIDITY: a non-token unit (for
       * Robinhood Stock Tokens: one underlying share, since SY.exchangeRate = uiMultiplier).
       */
      accountingUnit: { assetType: "TOKEN" | "LIQUIDITY" | "UNKNOWN"; description: string; syRateEqualsMultiplier: boolean | null };
      /** Onchain market reward tokens (market.getRewardTokens()). */
      rewardTokens: AssetRef[];
      /** Structural onchain identity checks and their results. */
      identityChecks: { check: string; ok: boolean | null; detail: string }[];
      /** API impliedApy (1e18) as a cross-check of the onchain value; null if unavailable. */
      apiImpliedApy: Measured<bigint> | null;
      createdAtBlock: bigint;
      /** SY.exchangeRate(): accounting-asset units per SY (1e18). For Stock Tokens it equals uiMultiplier. */
      syExchangeRate: Measured<bigint> | null;
      /** RouterStatic spot rates, accounting-asset units per token (1e18). */
      ptToAssetRate: Measured<bigint> | null;
      ytToAssetRate: Measured<bigint> | null;
      lpToAssetRate: Measured<bigint> | null;
      /** 1 − ptToAssetRate: the PT's current discount to its maturity redemption value (Fixed18). */
      ptDiscount: Measured<bigint> | null;
      /** Pendle API ROI at expiry (not annualized), where given. */
      ptRoiToMaturity: Measured<bigint> | null;
      ytRoiToMaturity: Measured<bigint> | null;
      /** Pendle API `liquidity.usd` (PT + SY in the AMM, API prices). */
      apiLiquidityUsd: Measured<UsdAmount> | null;
      poolTotalPt: bigint | null;
      poolTotalSy: bigint | null;
      protocolListed: boolean | null;
    }
  | {
      kind: "MORPHO_VAULT_V2";
      vault: Address;
      name: string;
      curator: Address | null;
      /** Onchain totalAssets(); API figure only if onchain is unreadable; null if neither. */
      totalAssets: Measured<TokenAmount> | null;
      performanceFee: Fixed18 | null;
      managementFee: Fixed18 | null;
    };

export interface Opportunity {
  /** Stable, deterministic: `${chainId}:${protocolId}:${category}:${venueKind}:${venueId}`. */
  id: string;
  chainId: number;
  protocol: { id: string; name: string };
  category: OpportunityCategory;
  title: string;
  venue: { kind: string; id: string; address: Address | null };

  /** The asset a holder uses to take this opportunity ("I own X"). */
  primaryAsset: AssetRef;
  inputAssets: AssetRef[];
  outputAssets: AssetRef[];
  collateralAssets: AssetRef[];
  borrowAssets: AssetRef[];

  yields: YieldMetric[];
  tvl: Measured<AmountWithUsd> | null;
  availableLiquidity: Measured<AmountWithUsd> | null;
  /** What availableLiquidity measures (never compare across kinds). */
  liquidityKind: LiquidityKind | null;
  utilization: Measured<Fixed18> | null;
  liquidation: LiquidationTerms | null;
  term: { maturity: string | null; lockSeconds: number | null; withdrawal: "INSTANT_SUBJECT_TO_LIQUIDITY" | "AT_MATURITY" | "TRADE_BEFORE_MATURITY" | "LOCKED" | "UNKNOWN" } | null;
  lifecycle: Lifecycle;
  entry: EntryRequirement;
  /** Verified relationships between the tokens involved (wrapper → underlying, PT → SY …). */
  relationships: AssetRelationship[];
  /** Filled by the Opportunity Engine from generic rules; adapters leave it null. */
  eligibility: Eligibility | null;
  contracts: ContractRef[];
  risk: OpportunityRisk;
  details: OpportunityDetails;

  provenance: DataSource[];
  conflicts: DataConflict[];
  warnings: Warning[];
  /** Worst freshness among the opportunity's measured values. */
  freshness: FreshnessInfo;
  verificationStatus: VerificationStatus;
  observedAt: string;
  generatedAt: string;
}

export function opportunityId(chainId: number, protocolId: string, category: OpportunityCategory, venueKind: string, venueId: string): string {
  return `${chainId}:${protocolId}:${category}:${venueKind}:${venueId.toLowerCase()}`;
}
