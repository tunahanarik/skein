/**
 * Uniswap on Robinhood Chain. Every address comes from the official deployment registry
 * https://github.com/Uniswap/contracts/blob/main/deployments/json/4663.json ("latest"), and each
 * was re-verified live (code present, factory views answer) — docs/protocols/uniswap-adapter.md.
 *
 * Only READ contracts are used by the adapter. Execution contracts are recorded for future
 * phases and are never called.
 */
import { parseAbi, parseAbiItem, type Address } from "viem";

export const UNISWAP_DEPLOYMENT_SOURCE = "https://github.com/Uniswap/contracts/blob/main/deployments/json/4663.json";

/** Used by the Phase 4 adapter (read-only). */
export const UNISWAP_READ_CONTRACTS = {
  v3Factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
  quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
} as const satisfies Record<string, Address>;

/** Recorded for future phases only. NEVER called in Phase 4. */
export const UNISWAP_RECORDED_ONLY = {
  v2Factory: "0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f",
  v2Router02: "0x89e5db8b5aa49aa85ac63f691524311aeb649eba",
  v3NonfungiblePositionManager: "0x73991a25c818bf1f1128deaab1492d45638de0d3",
  v3SwapRouter02: "0xcaf681a66d020601342297493863e78c959e5cb2",
  v3TickLens: "0x7dfd4f31be6814d2906bde155c3e1b146eac1468",
  v4PoolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  v4StateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  v4Quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  v4PositionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
  universalRouter_v2_1_2: "0x204faca1764b154221e35c0d20abb3c525710498",
  mixedRouteQuoterV2: "0x7edd862aa08dd5be664c21188e1a2a0e64e3a283",
  permit2: "0x000000000022d473030f116ddee9f6b43ac78ba3",
  uniswapInterfaceMulticall: "0x282a3c4d320cc7f0d5eaf56b8029e4b88338f0a3",
} as const satisfies Record<string, Address>;

/** Fee tiers enabled on the v3 factory, measured live via feeAmountTickSpacing (ppm → tickSpacing). */
export const V3_FEE_TIERS: Readonly<Record<number, number>> = { 100: 1, 500: 10, 3000: 60, 10000: 200 };

export const poolCreatedEvent = parseAbiItem("event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)");

export const v3FactoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)", "function feeAmountTickSpacing(uint24) view returns (int24)"]);
export const v3PoolAbi = parseAbi([
  "function factory() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function tickSpacing() view returns (int24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
]);
export const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
/**
 * QuoterV2 is not a `view` function: it simulates the swap and reverts with the result. Called
 * only through eth_call (never sent), and only for routes whose pools are factory-verified and
 * whose tokens are all canonical (so no untrusted token code runs in the simulation).
 */
/**
 * A Uniswap-v3-style concentrated-liquidity DEX ("dialect"). The adapter, identity checks, state
 * reads and quotes are shared; what differs is here. Uniswap keys pools by FEE tier with a static
 * fee; Ramses keys them by TICK_SPACING and its pools report a DYNAMIC fee (read every run).
 */
export interface V3Dialect {
  protocol: { id: string; name: string };
  /** "Uniswap v3", "Ramses CL" — used in titles and warnings. */
  label: string;
  /** Name of the factory in identity-check labels (stable strings, asserted by tests). */
  factoryLabel: string;
  venueKind: string;
  factory: Address;
  quoter: Address;
  deploymentSource: string;
  poolKey: "FEE" | "TICK_SPACING";
  /** FEE: fee ppm → tickSpacing. TICK_SPACING: tickSpacing → initial fee ppm (both measured live). */
  tiers: Readonly<Record<number, number>>;
  dynamicFee: boolean;
  mutability: string;
  mutabilitySource: string;
  /** Identity checks (prefixes) that establish origin. Default: pool.factory() + factory.getPool. */
  originChecks?: [string, string];
  /** How reserves are measured, for provenance labels. Default: token.balanceOf(pool). */
  reservesMethod?: string;
  /** Warning attached to reserves (code + text). Default: v3 balances include uncollected fees. */
  reservesWarning?: { code: "RESERVES_INCLUDE_UNCOLLECTED_FEES" | "RESERVES_LOWER_BOUND"; text: string };
}

export const quoterV2Abi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

/** QuoterV2 variant keyed by tickSpacing (Ramses CL and other tickSpacing-keyed v3 forks). */
export const quoterV2TickSpacingAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
export const v3FactoryTickSpacingAbi = parseAbi(["function getPool(address,address,int24) view returns (address)"]);

export const UNISWAP_V3: V3Dialect = {
  protocol: { id: "uniswap", name: "Uniswap" },
  label: "Uniswap v3",
  factoryLabel: "v3 factory",
  venueKind: "uniswap-v3-pool",
  factory: UNISWAP_READ_CONTRACTS.v3Factory,
  quoter: UNISWAP_READ_CONTRACTS.quoterV2,
  deploymentSource: UNISWAP_DEPLOYMENT_SOURCE,
  poolKey: "FEE",
  tiers: V3_FEE_TIERS,
  dynamicFee: false,
  mutability: "token0, token1 and fee are fixed per v3 pool at creation; the factory owner can only enable fee tiers and set a protocol fee share",
  mutabilitySource: "https://github.com/Uniswap/v3-core",
};
