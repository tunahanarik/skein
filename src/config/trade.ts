/**
 * Centralized trade-routing policy (Phase 4). Canonical addresses only; symbols are never used
 * to identify an asset.
 */
import { CORE_ASSETS } from "./assets.js";
import { DEFAULT_ELIGIBILITY_POLICY } from "./eligibility.js";

export interface RoutingPolicy {
  /**
   * One-hop routes may pass ONLY through these assets (registry keys). Both are canonical and
   * are the two deepest hubs measured live (docs/trade-routing.md).
   */
  routingAssetKeys: readonly string[];
  /** 1 = DIRECT only, 2 = DIRECT + ONE_HOP. Nothing longer is supported. */
  maxHops: 1 | 2;
  /** Markets below this TVL are not routing edges (same value as the DUST_LIQUIDITY policy). */
  minEdgeTvlUsdE18: bigint;
}

const key = (a: `0x${string}`) => `4663:${a.toLowerCase()}`;

export const ROUTING_POLICY: RoutingPolicy = {
  routingAssetKeys: [key(CORE_ASSETS.USDG.address), key(CORE_ASSETS.WETH.address)],
  maxHops: 2,
  minEdgeTvlUsdE18: DEFAULT_ELIGIBILITY_POLICY.dustLiquidityUsdE18,
};

/**
 * Wall-clock budget for the resumable cold pool-event scan per adapter run. On the public RPC a
 * full scan takes several minutes (rate limits + server-side log timeouts, measured 2026-09-24);
 * each run advances it and persists progress, while the factory getPool sweep already covers the
 * token×hub pools. Keyed providers finish in one run.
 */
export const DISCOVERY_SCAN_BUDGET_MS = 30_000;

/**
 * DEX spot price vs Phase 1 portfolio price: above this relative gap a MARKET_PRICE_DIVERGENCE
 * warning is recorded (neither side is declared correct). 2 %: pool fees (0.01–1 %) plus the
 * Chainlink 0.5 % deviation threshold put normal disagreement well below it.
 */
export const MARKET_PRICE_DIVERGENCE_PCT = 2;
