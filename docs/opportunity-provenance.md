# Opportunity provenance and freshness

Every displayed number must answer four questions: **where from, how old, supplied or calculated, and how verified.**

## Per-value provenance
Every `Measured<T>` (and every `YieldMetric`) carries:

| Field | Example (Morpho BORROW_APY) | Example (LLTV) |
|---|---|---|
| `source.type` | `OFFICIAL_API` | `ONCHAIN` |
| `source.provider` | `morpho-api` | `robinhood-chain-rpc` |
| `source.url` / `contract` | `https://api.morpho.org/graphql` | `0x9D53…1010` (Morpho) |
| `source.method` | `state.borrowApy` | `idToMarketParams(id)` |
| `source.blockNumber` | — | the block the params were read at |
| `source.sourceTimestamp` | API `state.timestamp` | — |
| `observedAt` | source time (API state time or block time) | block time |
| `freshness` | `{status, ageSeconds, rule}` | same |
| `origin` | `SUPPLIED` | `SUPPLIED` |
| `formula` | — | (computed values only, e.g. utilization) |
| `verification` | `VERIFIED_OFFICIAL_API` | `VERIFIED_ONCHAIN` |

The UI can therefore render "Updated 18 seconds ago · Source: Morpho API" per value, or "Source: Robinhood Chain block 71,205,943".

Asset identity provenance is the Phase 1 registry (Robinhood `/rhj/assets` + onchain identity check). Prices come from the Phase 1 Price Service (Chainlink / Robinhood quote). Each opportunity also lists all sources in `provenance[]` and all disagreements in `conflicts[]`.

Pendle examples (Phase 3):

| Value | Source |
|---|---|
| IMPLIED_APY | `ONCHAIN`, `robinhood-chain-rpc`, `_storage().lastLnImpliedRate` at the block, `origin: COMPUTED`, formula `exp(lastLnImpliedRate / 1e18) − 1` |
| YIELD_EXPOSURE_APY | `OFFICIAL_API`, `pendle-api`, `markets/{address}.ytFloatingApy`, `sourceTimestamp` = API `dataUpdatedAt` |
| maturity | `ONCHAIN` `expiry()` read at the identity block |
| pool liquidity | `COMPUTED` from `_storage`, RouterStatic rates, `SY.exchangeRate` and `SY.previewRedeem`, priced by the Phase 1 Price Service |
| relationships | each edge carries the onchain call that proves it (see asset-relationships.md) |

Uniswap examples (Phase 4):

| Value | Source |
|---|---|
| pool identity | `ONCHAIN` `PoolCreated` event + pool views + `factory.getPool` round trip (identity block) |
| DEX price | `ONCHAIN` `slot0().sqrtPriceX96`, `origin: COMPUTED`, formula `sqrtPriceX96² / 2^192 × 10^(dec0 − dec1)`, kind `DEX_MARKET_PRICE` |
| reserves | `ONCHAIN` `token.balanceOf(pool)`, USD via the Price Service |
| TVL | `COMPUTED` Σ reserves × Phase 1 price; null if a side is unpriced |
| quote | `ONCHAIN` `QuoterV2.quoteExactInputSingle` via eth_call at the block; `INDICATIVE_QUOTE` |

## Opportunity-level status
- `verificationStatus` = the weakest of: asset identities (canonical → VERIFIED_ONCHAIN, else UNVERIFIED), onchain totals, and yield metrics.
  - It becomes **CONFLICT** on any identity conflict (Morpho params, Pendle PT/YT/SY/expiry) or a double-applied multiplier oracle.
  - For Pendle, a failed structural check makes it **UNVERIFIED**. Value disagreements (totals, implied rate, pool USD) are recorded as `conflicts` with the onchain value kept, and they do not change the status.
- `freshness` = the worst of the opportunity's measured values.

## Freshness rules (`packages/core/src/config/freshness.ts`)
| Rule | FRESH ≤ | AGING ≤ | Applies to | Rationale |
|---|---|---|---|---|
| ONCHAIN_STATE | 60 s | 10 min | totals, oracle price, vault totalAssets, positions | read at our own pinned block |
| PROTOCOL_MARKET_CONFIG | 1 h | 24 h | market identity / LLTV | immutable per market; only the list changes |
| PROTOCOL_API_MARKET_STATE | 1 h | 6 h | API APY, rewards, collateral posted | API state lags on idle markets (tens of minutes observed); AdaptiveCurveIRM drifts slowly |
| (Phase 1) CHAINLINK_*, ROBINHOOD_QUOTE, ASSET_REGISTRY | see pricing.md | | prices, registry | |

A missing source timestamp → **UNKNOWN**. For example, Morpho vault APYs have no state time in the API. We never fall back to our fetch time and call that fresh.

## Cache TTLs (`CACHE_TTL_MS`)
| Cache | TTL | Notes |
|---|---|---|
| PROTOCOL_MARKET_CONFIG | 1 h (Morpho: process-lifetime per verified market, since params are immutable) | slow configuration (Pendle identity) |
| PROTOCOL_MARKET_LIST | 10 min | Pendle market list from factory logs; incremental rescans |
| POOL_LIST | 10 min | Uniswap pool list from factory logs; incremental; persisted to `.cache/` |
| POOL_IDENTITY | 24 h | immutable per v3 pool; re-read each process |
| POOL_STATE | 15 s | one snapshot per block |
| QUOTE | 5 s | per (route, amount, block) |
| PROTOCOL_MARKET_STATE | 60 s | fast state |
| PROTOCOL_STATE_STALE_FALLBACK | 6 h | last-good state after a failed refresh, flagged PARTIAL |

Failures are never cached.

## Conflict thresholds
| Constant | Value | Meaning |
|---|---|---|
| PROTOCOL_TOTALS_CONFLICT_PCT | 2 % | API vs onchain totals; beyond it → DATA_CONFLICT (onchain kept) |
| ORACLE_MATCH_TOLERANCE_PPM | 1 ppm | oracle ÷ expected is matched against the structures 1 / m / P_loan / m×P_loan; same-feed matches agree to ~1e-17. Unmatched → INCONCLUSIVE, never CONSISTENT |
| ORACLE_DEVIATION_WARNING_PCT | 2 % | oracle vs independent price → ORACLE_PRICE_DEVIATION |
| PROTOCOL_RATE_CONFLICT_PCT | 1 % relative | API rate vs the same rate onchain (Pendle impliedApy). Observed 5e-6. |
| PROTOCOL_LIQUIDITY_CONFLICT_PCT | 5 % | API pool USD vs onchain pool value priced by us. Observed 0.01–0.3 %. |
| eligibility `lowLiquidityUsdE18` | $10,000 | `packages/core/src/config/eligibility.ts`; advisory only |
| eligibility `dustLiquidityUsdE18` | $50 | DUST_LIQUIDITY (excluding) and the minimum routing-edge TVL |
| MARKET_PRICE_DIVERGENCE_PCT | 2 % | DEX spot vs portfolio price → warning; neither declared correct |
| QUOTE_TIMEOUT_MS | 8 s | a slower quote is a retryable failure |
