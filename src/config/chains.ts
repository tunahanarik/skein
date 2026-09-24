import { defineChain } from "viem";

/**
 * Robinhood Chain mainnet. Every value below is sourced; see docs/research/network.md.
 * - chainId 4663: docs.robinhood.com/chain/connecting + eth_chainId 0x1237 (live).
 * - Public RPC: same docs page. Officially "Rate-Limited, Not for Production".
 * - Explorer: robinhoodchain.blockscout.com (docs). Its /api is behind a Cloudflare
 *   challenge for non-browser clients, so it is a link target only, not a data source.
 */
export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;
export const PUBLIC_RPC_URL = "https://rpc.mainnet.chain.robinhood.com";

/** Chains the app will talk to. Testnet is deliberately absent: no protocols to discover there. */
export const SUPPORTED_CHAIN_IDS = [ROBINHOOD_CHAIN_ID] as const;

export const robinhoodChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC_URL] } },
  blockExplorers: { default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" } },
  contracts: {
    // Canonical Multicall3 (aggregate3). Robinhood's own "L2 Multicall" at
    // 0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1 (docs /chain/protocol-contracts) reverts on
    // aggregate3, which viem's multicall needs. Both checked by scripts/validate-network.ts.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

/** Observed, not documented: ~0.1 s blocks (see network.md). Used only for rough range sizing. */
export const APPROX_BLOCK_TIME_SECONDS = 0.1;
