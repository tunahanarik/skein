/**
 * Pendle V2 on Robinhood Chain. Addresses from the official deployment file
 * pendle-core-v2-public/deployments/4663-core.json, each confirmed live 2026-09-24
 * (docs/research/pendle.md). ABIs are the minimal read-only fragments we call.
 */
import { parseAbi, parseAbiItem, type Address } from "viem";

export const PENDLE_DEPLOYMENT_SOURCE = "https://github.com/pendle-finance/pendle-core-v2-public/blob/main/deployments/4663-core.json";
export const PENDLE_DOCS = "https://docs.pendle.finance/";

export const PENDLE_CONTRACTS = {
  router: "0x888888888889758F76e7103c6CbF23ABbF58F946",
  routerStatic: "0x6813d43782395A1F2AAb42f39aeEDE03ac655e09",
  marketFactoryV6: "0x544BF81c855AE84c1e8b65d5E38770898D01EeE2",
  yieldContractFactoryV6: "0xa543BF1ac6441822E95eD408076bB53090a0a9d7",
  PENDLE: "0x5E49E1f85813F2B65858860A3FA231b4186f2e0E",
} as const satisfies Record<string, Address>;

export const createNewMarketEvent = parseAbiItem(
  "event CreateNewMarket(address indexed market, address indexed PT, int256 scalarRoot, int256 initialAnchor, uint256 lnFeeRateRoot)",
);

export const marketFactoryAbi = parseAbi(["function isValidMarket(address) view returns (bool)"]);
export const yieldFactoryAbi = parseAbi(["function isPT(address) view returns (bool)", "function isYT(address) view returns (bool)"]);
export const marketAbi = parseAbi([
  "function readTokens() view returns (address SY, address PT, address YT)",
  "function expiry() view returns (uint256)",
  "function isExpired() view returns (bool)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function getRewardTokens() view returns (address[])",
  "function _storage() view returns (int128 totalPt, int128 totalSy, uint96 lastLnImpliedRate, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext)",
  "function balanceOf(address) view returns (uint256)",
]);
export const ptAbi = parseAbi([
  "function SY() view returns (address)",
  "function YT() view returns (address)",
  "function expiry() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
]);
export const ytAbi = parseAbi(["function PT() view returns (address)", "function SY() view returns (address)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
export const syAbi = parseAbi([
  "function yieldToken() view returns (address)",
  "function getTokensIn() view returns (address[])",
  "function getTokensOut() view returns (address[])",
  "function assetInfo() view returns (uint8 assetType, address assetAddress, uint8 assetDecimals)",
  "function exchangeRate() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function paused() view returns (bool)",
  "function previewRedeem(address tokenOut, uint256 amountSharesToRedeem) view returns (uint256)",
]);
export const erc20MetaAbi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
export const routerStaticAbi = parseAbi([
  "function getPtToAssetRate(address market) view returns (uint256)",
  "function getYtToAssetRate(address market) view returns (uint256)",
  "function getLpToAssetRate(address market) view returns (uint256)",
]);

/** IStandardizedYield.AssetType: TOKEN = accounting unit is a token amount; LIQUIDITY = a non-token unit (e.g. shares). */
export const SY_ASSET_TYPES = ["TOKEN", "LIQUIDITY"] as const;
