import type { Address } from "viem";
import type { Rate } from "../lib/rates.js";
import type { DataSource, Metric } from "./provenance.js";
import type { RiskMetadata } from "./risk.js";
import type { VerificationStatus } from "./verification.js";

export const OPPORTUNITY_CATEGORIES = [
  "TRADE", // swap the asset for another
  "LEND", // supply the asset to earn interest
  "BORROW", // borrow the asset
  "COLLATERAL", // post the asset to borrow something else
  "LP", // provide liquidity to a pool
  "VAULT", // deposit into a managed / curated vault
  "FIXED_YIELD", // lock a fixed or implied rate to a maturity (e.g. Pendle PT)
  "YIELD", // other yield: savings rates, staking, yield tokens
] as const;
export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];

export type AssetKind = "NATIVE" | "WRAPPED_NATIVE" | "STABLECOIN" | "STOCK_TOKEN" | "VAULT_SHARE" | "LP_TOKEN" | "OTHER";

/**
 * Identity is (chainId, address). `symbol` is display-only and never used to match: this
 * chain has many look-alike USDG / WETH / Stock Token contracts.
 */
export interface AssetRef {
  chainId: number;
  address: Address;
  symbol: string;
  decimals: number;
  kind: AssetKind;
}

export interface YieldBreakdown {
  /** Headline yield the user would see. Null when the protocol gives none and we can't compute it. */
  total: Metric<Rate>;
  /** Organic part (interest / fees / savings rate). */
  base: Metric<Rate>;
  /** Incentive parts, each with its token and source (e.g. Merkl campaign). */
  rewards: RewardComponent[];
}

export interface RewardComponent {
  token: AssetRef | null;
  rate: Metric<Rate>;
  /** Eligibility text from the source, e.g. "Robinhood Users Only" whitelist campaigns. */
  eligibility: string | null;
  campaignId: string | null;
}

export interface FeeInfo {
  kind: "SWAP" | "PERFORMANCE" | "MANAGEMENT" | "PROTOCOL" | "DEPOSIT" | "WITHDRAWAL";
  /** Fraction (0.003 = 0.3%). */
  value: Metric<number>;
}

export interface ContractRef {
  role: string; // "market", "vault", "pool", "oracle", "irm", "router" ...
  address: Address;
}

/** Type-specific details. A discriminated union keeps category-only fields off other kinds. */
export type OpportunityDetails =
  | {
      type: "LENDING_MARKET"; // Morpho-style isolated market
      marketId: string;
      loanAsset: AssetRef;
      collateralAsset: AssetRef | null;
      lltv: Metric<number>;
      borrowApy: Metric<Rate>;
      totalSupplyUsd: Metric<number>;
      totalBorrowUsd: Metric<number>;
    }
  | {
      type: "VAULT";
      vaultAddress: Address;
      standard: "ERC4626" | "MORPHO_VAULT_V2" | "OTHER";
      curator: string | null;
      /** Where the vault's funds are allocated, if the source exposes it. */
      allocations: { target: string; usd: Metric<number> }[];
    }
  | {
      type: "POOL";
      dex: string;
      poolRef: string; // pool address (v2/v3) or poolId (v4 singleton)
      pairAsset: AssetRef;
      feeTier: Metric<number>; // fraction; per-swap dynamic fees reported as null + note
      hooks: Address | null;
    }
  | {
      type: "FIXED_TERM";
      market: Address;
      principalToken: AssetRef | null;
      yieldToken: AssetRef | null;
      maturity: string; // ISO
    }
  | { type: "SAVINGS"; vaultAddress: Address };

export interface TrustedLink {
  url: string;
  /** Host that matched the protocol's allowlist in src/config/protocols.ts. */
  host: string;
}

export interface Opportunity {
  /** Deterministic: `${chainId}:${protocolId}:${category}:${venueRef}` so re-fetches dedupe. */
  id: string;
  chainId: number;
  protocolId: string;
  protocolName: string;
  category: OpportunityCategory;
  title: string;

  /** The user's asset this opportunity was found for. */
  asset: AssetRef;
  /** What the user puts in / gets back (a vault share, an LP token, a PT ...). */
  inputAssets: AssetRef[];
  outputAssets: AssetRef[];
  collateralAssets: AssetRef[];
  borrowAssets: AssetRef[];

  yield: YieldBreakdown | null;
  tvlUsd: Metric<number>;
  availableLiquidityUsd: Metric<number>;
  utilization: Metric<number>;
  fees: FeeInfo[];

  details: OpportunityDetails;
  contracts: ContractRef[];
  risk: RiskMetadata;

  /** Only links that passed the protocol host allowlist; otherwise null. */
  deepLink: TrustedLink | null;

  /** Every source that fed any field above (deduplicated). */
  dataSources: DataSource[];
  /** Newest observation time among the fields (ISO). */
  lastUpdated: string;
  /** Weakest status among the fields the UI treats as critical (yield, TVL, contracts). */
  verification: VerificationStatus;
}

export function opportunityId(chainId: number, protocolId: string, category: OpportunityCategory, venueRef: string): string {
  return `${chainId}:${protocolId}:${category}:${venueRef.toLowerCase()}`;
}
