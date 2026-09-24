import type { Address } from "viem";
import type { RpcHealthSnapshot } from "../chain/health.js";
import type { FreshnessInfo } from "../config/freshness.js";
import type { DataSource } from "../model/provenance.js";
import type { VerificationStatus } from "../model/verification.js";
import type { Warning } from "../model/warnings.js";
import type { PriceQuote } from "../pricing/types.js";
import type { AssetType } from "../registry/asset.js";
import type { RegistryMode } from "../registry/registry.js";
import type { BalanceStatus } from "./balanceReader.js";

export interface PortfolioAssetIdentity {
  key: string;
  chainId: number;
  address: Address | null;
  symbol: string;
  name: string;
  decimals: number;
  type: AssetType;
  canonical: boolean;
}

export interface StockDisplay {
  /** 1e18 fixed point; the value applied to this row. */
  uiMultiplierE18: bigint;
  uiMultiplier: string;
  multiplierSource: "ONCHAIN" | "REGISTRY";
  /** Share-equivalent base units (18 dp) and decimal string. Derived; not transferable units. */
  displayShareBalanceRaw: bigint;
  displayShareBalance: string;
  pendingMultiplier: string | null;
  pendingEffectiveAt: string | null;
}

export interface PortfolioAsset {
  asset: PortfolioAssetIdentity;
  balanceStatus: BalanceStatus;
  /** Token base units exactly as balanceOf/eth_getBalance returned them. */
  rawBalance: bigint | null;
  /** rawBalance / 10^decimals as an exact decimal string: "tokens held". */
  displayBalance: string | null;
  stock: StockDisplay | null;
  price: PriceQuote | null;
  pricingStatus: "PRICED" | "UNPRICED";
  /** rawBalance × priceUsd, 1e18-scaled integer and decimal string. */
  valueUsdE18: bigint | null;
  valueUsd: string | null;
  verificationStatus: VerificationStatus;
  warnings: Warning[];
  provenance: DataSource[];
}

export type CoverageStatus = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export interface Portfolio {
  chainId: number;
  walletAddress: Address;
  blockNumber: bigint;
  blockTimestamp: string;
  assets: PortfolioAsset[];
  totals: {
    /** Sum of priced holdings only. Never labelled a "total portfolio value" unless coverage is COMPLETE. */
    pricedValueUsdE18: bigint;
    pricedValueUsd: string;
    pricedAssetCount: number;
    unpricedAssetCount: number;
    failedBalanceCount: number;
    heldAssetCount: number;
  };
  valuationCoverage: {
    pricedAssets: number;
    unpricedAssets: number;
    failedBalances: number;
    coverageStatus: CoverageStatus;
    /** Present only when coverage is COMPLETE. */
    totalValueUsd: string | null;
  };
  registry: {
    mode: RegistryMode;
    dataAsOf: string;
    freshness: FreshnessInfo;
    stockTokenCount: number;
    scannedAssetCount: number;
    onchainVerified: number | null;
  };
  rpc: RpcHealthSnapshot;
  warnings: Warning[];
  timingsMs: { registry: number; balances: number; prices: number; normalization: number; total: number };
  generatedAt: string;
  provenance: DataSource[];
}
