/**
 * Ramses CL on Robinhood Chain as a Uniswap-v3-style dialect (the shared v3 adapter reads it).
 *
 * Official addresses: https://www.ramses.xyz/docs/contract-addresses ("Robinhood" section), read
 * 2026-09-24: RamsesV3Factory 0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8, QuoterV2
 * 0x4730e03EB4a58A5e20244062D5f9A99bCf5770a6. Verified live the same day:
 *   - the factory emits Uniswap's PoolCreated(token0, token1, fee, tickSpacing, pool) (510 pools)
 *   - getPool(tokenA, tokenB, int24 tickSpacing) returns the USDG/NVDA ts=10 pool
 *     0xdac1904D823F7d6bcAaF431ceEe40c934fEd321b, whose factory() is the factory
 *   - pools expose Uniswap's slot0()/liquidity(); fee() is DYNAMIC (140 ppm while the tier's initial
 *     fee is 500) — so the fee is read with every state read
 *   - tickSpacingInitialFee(ts): 1→100, 5→250, 10→500, 50→3000, 100→10000, 200→20000
 *   - QuoterV2.quoteExactInputSingle((tokenIn, tokenOut, amountIn, int24 tickSpacing, limit)) quoted
 *     1 NVDA → 222.43 USDG through that pool (eth_call)
 */
import type { V3Dialect } from "../uniswap/constants.js";

export const RAMSES_DOCS = "https://www.ramses.xyz/docs/contract-addresses";

export const RAMSES_CL: V3Dialect = {
  protocol: { id: "ramses", name: "Ramses" },
  label: "Ramses CL",
  factoryLabel: "Ramses CL factory",
  venueKind: "ramses-cl-pool",
  factory: "0xe0c4ceb92d08ca985bb70fe0a22feb121a9854a8",
  quoter: "0x4730e03eb4a58a5e20244062d5f9a99bcf5770a6",
  deploymentSource: RAMSES_DOCS,
  poolKey: "TICK_SPACING",
  tiers: { 1: 100, 5: 250, 10: 500, 50: 3000, 100: 10000, 200: 20000 },
  dynamicFee: true,
  mutability: "token0, token1 and tickSpacing are fixed per pool; the swap fee is dynamic (set by the protocol) and is read at every block",
  mutabilitySource: RAMSES_DOCS,
};

export const RAMSES_POOL_CACHE_PATH = ".cache/ramses-cl-pools-4663.json";
