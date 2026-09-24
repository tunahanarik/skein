import { CORE_ASSETS } from "../config/assets.js";
import { ROBINHOOD_CHAIN_ID } from "../config/chains.js";
import { assetKey, type Asset } from "./asset.js";

/**
 * Non-Stock-Token canonical assets. Values are the Phase 0 verified config
 * (docs/research/network.md, usdg.md); nothing here is fetched.
 */
const docs = (url: string, method: string) => ({
  type: "OFFICIAL_DOCS" as const,
  provider: "phase0-verified-config",
  url,
  chainId: ROBINHOOD_CHAIN_ID,
  method,
  observedAt: "2026-09-24T00:00:00.000Z",
});

export function coreAssets(): Asset[] {
  return [
    {
      key: assetKey(ROBINHOOD_CHAIN_ID, null),
      chainId: ROBINHOOD_CHAIN_ID,
      address: null,
      symbol: "ETH",
      name: "Ether",
      decimals: 18,
      type: "NATIVE",
      canonical: true,
      verificationStatus: "VERIFIED_OFFICIAL_DOCS",
      priceMethods: ["CHAINLINK_ETH_USD"],
      provenance: [docs("https://docs.robinhood.com/chain/connecting", "nativeCurrency")],
    },
    {
      key: assetKey(ROBINHOOD_CHAIN_ID, CORE_ASSETS.WETH.address),
      chainId: ROBINHOOD_CHAIN_ID,
      address: CORE_ASSETS.WETH.address,
      symbol: "WETH",
      name: CORE_ASSETS.WETH.name,
      decimals: CORE_ASSETS.WETH.decimals,
      type: "WRAPPED_NATIVE",
      canonical: true,
      verificationStatus: CORE_ASSETS.WETH.verification,
      // WETH is priced at ETH/USD: it is 1:1 redeemable for ETH by the token contract.
      priceMethods: ["CHAINLINK_ETH_USD"],
      provenance: [docs(CORE_ASSETS.WETH.officialSource, "L2 WETH")],
    },
    {
      key: assetKey(ROBINHOOD_CHAIN_ID, CORE_ASSETS.USDG.address),
      chainId: ROBINHOOD_CHAIN_ID,
      address: CORE_ASSETS.USDG.address,
      symbol: "USDG",
      name: CORE_ASSETS.USDG.name,
      decimals: CORE_ASSETS.USDG.decimals,
      type: "STABLECOIN",
      canonical: true,
      verificationStatus: CORE_ASSETS.USDG.verification,
      priceMethods: ["CHAINLINK_USDG_USD"],
      provenance: [docs(CORE_ASSETS.USDG.officialSource, "USDG Robinhood Mainnet")],
    },
  ];
}
