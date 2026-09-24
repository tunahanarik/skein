import { getAddress, type Address, type Hex } from "viem";
import { ROBINHOOD_CHAIN_ID } from "../config/chains.js";
import type { DataSource } from "../model/provenance.js";
import type { VerificationStatus } from "../model/verification.js";

export type AssetType = "NATIVE" | "STOCK_TOKEN" | "STABLECOIN" | "WRAPPED_NATIVE" | "ERC20" | "UNKNOWN";

/** How the Price Service may price an asset. Order = preference. */
export type PriceMethod =
  | "CHAINLINK_ETH_USD" // ETH and WETH
  | "CHAINLINK_USDG_USD" // USDG
  | "CHAINLINK_STOCK_TOKEN_FEED" // token price, multiplier included
  | "ROBINHOOD_QUOTE_MID"; // underlying share mid × uiMultiplier

export interface StockMetadata {
  /** bytes32 issuer id; equals the token's onchain uid(). */
  uid: Hex;
  /** Ticker as used by Robinhood's API (no prefix). */
  rhSymbol: string;
  isin: string | null;
  /** Registry (API) multiplier, 1e18 fixed point. The onchain value at the valuation block wins. */
  registryMultiplierE18: bigint;
  pendingMultiplierE18: bigint | null;
  pendingEffectiveAt: number | null;
  status: string;
  logoUrl: string | null;
}

export interface Asset {
  /** Identity: `${chainId}:native` or `${chainId}:${lowercase address}`. Never the symbol. */
  key: string;
  chainId: number;
  /** null only for the native coin. */
  address: Address | null;
  symbol: string; // display only
  name: string; // display only
  decimals: number;
  type: AssetType;
  /** In a verified canonical registry (core config or Robinhood's Stock Token list). */
  canonical: boolean;
  verificationStatus: VerificationStatus;
  underlying?: { symbol: string; isin: string | null };
  stockMetadata?: StockMetadata;
  priceMethods: PriceMethod[];
  provenance: DataSource[];
}

export const NATIVE_KEY = `${ROBINHOOD_CHAIN_ID}:native`;

export function assetKey(chainId: number, address: Address | null): string {
  return address === null ? `${chainId}:native` : `${chainId}:${address.toLowerCase()}`;
}

/** Checksummed form for display/output; lowercase is used only inside keys. */
export function checksum(address: string): Address {
  return getAddress(address);
}
