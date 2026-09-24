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
 * Default TRADE targets in the PRODUCT view (Phase 5, docs/asset-intelligence.md). The product
 * response lists routes to these assets only; every other destination is counted and stays
 * available through an explicit `tradeTarget` or the raw APIs. Chosen from live measurements
 * (2026-09-24): the two deepest routing hubs — USDG (127 active v3 pools ≥ $50 against 76 distinct
 * canonical counterparts) and WETH (WETH/USDG 0.01 % pool $18.9M TVL).
 */
export const PRODUCT_TRADE_TARGET_KEYS: readonly string[] = [key(CORE_ASSETS.USDG.address), key(CORE_ASSETS.WETH.address)];

/**
 * PRODUCT-mode display cap: route cards shown per trade target after ranking (a UX limit, not a
 * quality judgement). NVDA had 30 visible routes to its two default targets (live, 2026-09-24);
 * the remainder is reported as `moreRoutes` and every route stays available in DEBUG mode and
 * through the raw APIs.
 */
export const PRODUCT_MAX_ROUTES_PER_TARGET = 5;

/**
 * Quotes in flight at once for one explicit-amount request. Sequential quoting took ≈ 5.4 s for
 * 14 NVDA→USDG routes on the public RPC (2026-09-24); 3 keeps the burst well under the provider's
 * rate limit while cutting the wait roughly threefold. The reader still retries on 429.
 */
export const QUOTE_CONCURRENCY = 3;

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
