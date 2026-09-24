import type { Address } from "viem";
import type { AssetKind } from "../model/opportunity.js";
import type { VerificationStatus } from "../model/verification.js";

/**
 * Verified static asset entries. Stock Tokens are NOT hardcoded here as a list: the
 * canonical set is Robinhood's live registry (GET https://api.robinhood.com/rhj/assets,
 * see src/sources/robinhood.ts), cross-checked onchain by scripts/validate-assets.ts.
 * The sample Stock Tokens below exist only as fixtures for tests and research scripts.
 *
 * Rule: nothing enters this file without an official source AND a live onchain check.
 */
export interface AssetConfig {
  address: Address;
  symbol: string; // display only; identity is the address
  name: string;
  decimals: number;
  kind: AssetKind;
  verification: VerificationStatus;
  /** Official source that names this address. */
  officialSource: string;
  /** Chainlink USD feed proxy (from the Chainlink directory), if one exists. */
  usdFeed: Address | null;
  checkedAt: string;
}

export const CORE_ASSETS = {
  WETH: {
    address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    symbol: "WETH",
    name: "WETH",
    decimals: 18,
    kind: "WRAPPED_NATIVE",
    verification: "VERIFIED_ONCHAIN",
    officialSource: "https://docs.robinhood.com/chain/protocol-contracts",
    usdFeed: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9", // "ETH / USD"
    checkedAt: "2026-09-24",
  },
  USDG: {
    address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    symbol: "USDG",
    name: "Global Dollar",
    decimals: 6,
    kind: "STABLECOIN",
    verification: "VERIFIED_ONCHAIN",
    officialSource: "https://docs.paxos.com/guides/stablecoin/usdg/mainnet",
    usdFeed: "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2", // "USDG / USD"
    checkedAt: "2026-09-24",
  },
} as const satisfies Record<string, AssetConfig>;

/** Stock Token beacon / ACCESS_CONTROLLED_REGISTRY shared by all 195 listed tokens. */
export const STOCK_TOKEN_REGISTRY: Address = "0xe10b6f6b275de231345c20d14ab812db62151b00";
/** Stock Token factory (emits Deployed(uid, token, name, symbol)); deploying ≠ being listed. */
export const STOCK_TOKEN_FACTORY: Address = "0x4783c67b63de2b358ac5951a7d41f47a38f3c046";

/**
 * Sample Stock Tokens, verified 2026-09-24 at block 71142408: listed ACTIVE in /rhj/assets,
 * uid()/symbol()/decimals()/uiMultiplier() match the API, beacon = STOCK_TOKEN_REGISTRY.
 */
export const SAMPLE_STOCK_TOKENS = {
  NVDA: {
    address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    uid: "0x00000000000000000000000000000000915f477416294f5099a5e0e09f327ce5",
    usdFeed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
  },
  AAPL: {
    address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    uid: "0x00000000000000000000000000000000c2425be3658540dd8e2424cbf3c5c649",
    usdFeed: "0x6B22A786bAa607d76728168703a39Ea9C99f2cD0",
  },
  TSLA: {
    address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    uid: "0x00000000000000000000000000000000cfece3244ea34bb29414dd9488b32d9f",
    usdFeed: "0x4A1166a659A55625345e9515b32adECea5547C38",
  },
  GOOGL: {
    address: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
    uid: "0x0000000000000000000000000000000053b69e2076884cc9ae2ada9bc7095df3",
    usdFeed: "0xF6f373a037c30F0e5010d854385cA89185AE638b",
  },
} as const satisfies Record<string, { address: Address; uid: string; usdFeed: Address }>;
