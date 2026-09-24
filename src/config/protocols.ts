import type { Address } from "viem";
import type { OpportunityCategory } from "../model/opportunity.js";
import type { VerificationStatus } from "../model/verification.js";

/**
 * Production protocol registry. Admission rule: an OFFICIAL deployment source names the
 * addresses AND a live onchain read confirmed them (code + a meaningful view call).
 * Candidates that fail either test live in research/unverified.json, never here.
 * Evidence for every entry: docs/research/protocols.md.
 */
export interface ProtocolConfig {
  id: string;
  name: string;
  categories: OpportunityCategory[];
  verification: VerificationStatus;
  /** Official page/file that lists the Robinhood Chain addresses. */
  deploymentSource: string;
  /** Official docs page actually read during research; null when none was checked. */
  docs: string | null;
  /** Data endpoints that cover chain 4663 (keyless unless noted). */
  dataSources: { kind: "API" | "SUBGRAPH" | "ONCHAIN"; url: string; covers4663: true; note?: string }[];
  contracts: Record<string, Address>;
  /**
   * Hosts a deep link may point at; anything else from an API is dropped. Empty until the
   * app domain is confirmed from the protocol's own docs (open question, docs/open-questions.md).
   */
  linkHosts: string[];
  checkedAt: string;
}

export const PROTOCOLS: ProtocolConfig[] = [
  {
    id: "morpho",
    name: "Morpho",
    categories: ["LEND", "BORROW", "COLLATERAL", "VAULT"],
    verification: "VERIFIED_ONCHAIN",
    deploymentSource: "https://docs.morpho.org/developers/contracts/addresses/",
    docs: "https://docs.morpho.org/",
    dataSources: [
      { kind: "API", url: "https://api.morpho.org/graphql", covers4663: true },
      { kind: "ONCHAIN", url: "Morpho.market(id) / idToMarketParams(id) / position(id,user)", covers4663: true },
    ],
    contracts: {
      morpho: "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010",
      adaptiveCurveIrm: "0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1",
      chainlinkOracleV2Factory: "0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2",
      vaultV2Factory: "0x0FBad98595b0186dA120E41f77C102beb49f803c",
      publicAllocator: "0xCe5c1aFa115fF8b1D6913509bfc79D9AE08CC857",
      bundler3: "0x6478e9393d4C5bB4d53ee881d1DE78786A0344a6",
    },
    linkHosts: [],
    checkedAt: "2026-09-24",
  },
  {
    id: "spark-savings",
    name: "Spark Savings",
    categories: ["YIELD", "VAULT"],
    verification: "VERIFIED_ONCHAIN",
    deploymentSource: "https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Robinhood.sol",
    docs: "https://docs.spark.finance/products/spark-savings",
    dataSources: [{ kind: "ONCHAIN", url: "spUSDG.vsr() / totalAssets()", covers4663: true, note: "no official rates API found" }],
    contracts: { spUSDG: "0xde770c84FE66E063336b31737cFE9790f18c4087" },
    linkHosts: [],
    checkedAt: "2026-09-24",
  },
  {
    id: "pendle",
    name: "Pendle",
    categories: ["FIXED_YIELD", "YIELD", "LP"],
    verification: "VERIFIED_ONCHAIN",
    deploymentSource: "https://github.com/pendle-finance/pendle-core-v2-public/blob/main/deployments/4663-core.json",
    docs: "https://api-v2.pendle.finance/core/docs",
    dataSources: [{ kind: "API", url: "https://api-v2.pendle.finance/core/v2/markets/all?chainId=4663", covers4663: true }],
    contracts: {
      router: "0x888888888889758F76e7103c6CbF23ABbF58F946",
      marketFactoryV6: "0x544BF81c855AE84c1e8b65d5E38770898D01EeE2",
    },
    linkHosts: [],
    checkedAt: "2026-09-24",
  },
  {
    id: "uniswap",
    name: "Uniswap",
    categories: ["TRADE", "LP"],
    verification: "VERIFIED_ONCHAIN",
    deploymentSource: "https://github.com/Uniswap/contracts/blob/main/deployments/json/4663.json",
    docs: "https://developers.uniswap.org/",
    dataSources: [
      { kind: "ONCHAIN", url: "V3Factory.getPool / PoolManager Initialize logs / StateView / QuoterV2 / V4Quoter", covers4663: true },
    ],
    contracts: {
      v2Factory: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
      v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
      v3QuoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
      v3PositionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
      v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
      v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
      v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
      v4PositionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    },
    linkHosts: [],
    checkedAt: "2026-09-24",
  },
  {
    id: "beefy",
    name: "Beefy",
    categories: ["LP", "VAULT"],
    verification: "VERIFIED_ONCHAIN",
    deploymentSource: "https://github.com/beefyfinance/beefy-v2/blob/main/src/config/vault/robinhood.json",
    docs: null,
    dataSources: [
      { kind: "API", url: "https://api.beefy.finance/cow-vaults", covers4663: true },
      { kind: "API", url: "https://api.beefy.finance/apy/breakdown", covers4663: true },
    ],
    contracts: {}, // per-vault addresses come from the API and are checked onchain before display
    linkHosts: [],
    checkedAt: "2026-09-24",
  },
  {
    id: "steer",
    name: "Steer",
    categories: ["LP", "VAULT"],
    verification: "VERIFIED_ONCHAIN",
    deploymentSource: "https://www.npmjs.com/package/@steerprotocol/sdk (src/const/deployments/robinhood.ts, v3.8.0)",
    docs: null,
    dataSources: [
      { kind: "API", url: "https://api.steer.finance/getAprs?chainId=4663&dexName=uniswap", covers4663: true },
      {
        kind: "SUBGRAPH",
        url: "https://api.goldsky.com/api/public/project_cm2k9xbkz4qg901vs51bm5uau/subgraphs/steer-protocol-robinhood/prod/gn",
        covers4663: true,
        note: "v4 vault totalAmount fields wrong; read getTotalAmounts() onchain",
      },
    ],
    contracts: { vaultRegistry: "0x5c7d564fA5CE0e874367121E33c1ff10dB2115dC" },
    linkHosts: [],
    checkedAt: "2026-09-24",
  },
];

/** Reward programs are a data source, not a venue: they attach to opportunities above. */
export const REWARD_SOURCES = [
  { id: "merkl", url: "https://api.merkl.xyz/v4/opportunities?chainId=4663", verification: "VERIFIED_OFFICIAL_API" as VerificationStatus },
];
