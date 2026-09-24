import type { Address } from "viem";
import type { Metric } from "./provenance.js";

/**
 * Objective, verifiable risk attributes. No score: every field is a fact with a source, or
 * explicitly unknown. A scoring model can be layered on later without changing this shape.
 *
 * Convention: `Metric<T>` is null when the attribute could not be established. "Unknown" is
 * itself information and the UI must show it as such, never as "no risk".
 */

export interface AuditRecord {
  auditor: string;
  /** Report URL on the auditor's or protocol's own domain. */
  reportUrl: string;
  date: string | null;
  /** Contracts / version the audit covered, as stated in the report. */
  scope: string | null;
}

export type UpgradeabilityKind =
  | "IMMUTABLE"
  | "EIP1967_PROXY"
  | "BEACON_PROXY" // e.g. every Stock Token: one registry upgrade changes all 195 at once
  | "MINIMAL_PROXY_CLONE" // EIP-1167 clone of a fixed implementation
  | "OTHER_PROXY";

export interface Upgradeability {
  kind: UpgradeabilityKind;
  implementation: Address | null;
  /** Who can upgrade (proxy admin / beacon owner), if readable. */
  admin: Address | null;
  adminKind: "EOA" | "CONTRACT" | "UNKNOWN";
  /** Timelock delay in seconds when the admin is a known timelock. */
  timelockSeconds: number | null;
}

export type OracleKind =
  | "CHAINLINK_FEED"
  | "MORPHO_CHAINLINK_V2" // Morpho's audited ChainlinkOracleV2 factory product
  | "META_ORACLE" // primary/backup switching oracle
  | "ERC4626_RATE" // vault share price
  | "FIXED_PRICE" // hardcoded 1:1 style oracle
  | "DEX_TWAP"
  | "CUSTOM"; // unrecognized contract: needs manual review

export interface OracleInfo {
  kind: OracleKind;
  address: Address;
  /** Underlying price feeds the oracle reads (e.g. Chainlink proxies). */
  feeds: Address[];
  /** Oldest `updatedAt` among the feeds, ISO. */
  lastUpdatedAt: string | null;
  /** Heartbeat from the Chainlink directory, seconds. */
  heartbeatSeconds: number | null;
  /**
   * For Stock Token collateral: whether the oracle's multiplier handling was checked against
   * the canonical "feed already includes uiMultiplier" rule. "DOUBLE_APPLIED" is a measured
   * finding (price ratio == uiMultiplier), see docs/research/morpho.md.
   */
  multiplierHandling: "CORRECT" | "DOUBLE_APPLIED" | "NOT_APPLICABLE" | "UNCHECKED";
}

/** Issuer-level controls on an asset (Stock Tokens and USDG both have them). */
export interface AssetControls {
  pausable: boolean | null;
  paused: boolean | null;
  /** Issuer can block addresses from transferring. */
  blocklist: boolean | null;
  /** Issuer can burn from any holder (selector-level evidence only unless source is verified). */
  adminBurn: boolean | null;
  upgradeable: Upgradeability | null;
}

export interface Withdrawal {
  kind: "INSTANT" | "SUBJECT_TO_LIQUIDITY" | "QUEUE" | "AT_MATURITY" | "LOCKED" | "UNKNOWN";
  lockSeconds: number | null;
  /** e.g. deposit gates / "Robinhood users only" restrictions reported by the protocol. */
  restrictions: string[];
}

export interface RiskMetadata {
  audits: Metric<AuditRecord[]>;
  upgradeability: Metric<Upgradeability>;
  oracle: Metric<OracleInfo>;
  /** Controls on every asset the user would hold or be exposed to, keyed by address. */
  assetControls: Record<Address, Metric<AssetControls>>;
  /** Liquidation loan-to-value (Morpho LLTV), fraction. */
  liquidationLtv: Metric<number>;
  liquidationPenalty: Metric<number>;
  withdrawal: Metric<Withdrawal>;
  /** Unix-ISO maturity for fixed-term products. */
  maturity: Metric<string>;
  /** Fraction of the displayed APY that comes from incentives (0–1). */
  rewardDependence: Metric<number>;
  /**
   * Number of distinct protocols/contracts value passes through (e.g. vault → market →
   * oracle → feed = 4). Objective proxy for composability risk.
   */
  dependencyDepth: Metric<number>;
  /** Every asset whose price or solvency the position depends on. */
  underlyingExposure: Address[];
  /** Curation / listing signal from the protocol itself (e.g. Morpho `listed`). */
  protocolListed: Metric<boolean>;
  /** Warnings reported by the protocol's own API, passed through verbatim. */
  protocolWarnings: Metric<{ type: string; level: string }[]>;
}

export function emptyRisk(): RiskMetadata {
  return {
    audits: null,
    upgradeability: null,
    oracle: null,
    assetControls: {},
    liquidationLtv: null,
    liquidationPenalty: null,
    withdrawal: null,
    maturity: null,
    rewardDependence: null,
    dependencyDepth: null,
    underlyingExposure: [],
    protocolListed: null,
    protocolWarnings: null,
  };
}
