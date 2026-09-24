# Trade routing and indicative quotes

`src/trade/graph.ts` (graph and routes), `src/trade/compare.ts` (quote comparison), `src/config/trade.ts` (policy). The routing layer is venue-independent: any adapter that publishes TRADE opportunities contributes edges.

## Graph

- **Nodes:** canonical assets (registry keys).
- **Edges:** `TradeMarket`s that pass **all** of the following (checked in this order):

  | Requirement | Rejection reason |
  |---|---|
  | both assets canonical | `ASSET_NOT_CANONICAL` |
  | origin verified (e.g. factory event + `factory.getPool` round trip) | `ORIGIN_NOT_VERIFIED` |
  | not conflicted | `CONFLICT` |
  | state ACTIVE | `STATE_NOT_ACTIVE` |
  | priced TVL | `SIZE_UNKNOWN` |
  | TVL ≥ `minEdgeTvlUsdE18` ($50, the same value as DUST_LIQUIDITY) | `DUST` |

  Rejected markets are listed with their reason; nothing is deleted.
- **Metadata per edge:** venue, market, fee, TVL, verification and freshness, all read from the `TradeMarket`.

The graph is **derived** from the current markets on every request. It is cheap (milliseconds) and is not cached separately. This means it can never be staler than the markets it is built from.

## Routes: DIRECT and ONE_HOP only

- **DIRECT:** every eligible edge between input and output.
- **ONE_HOP:** input → H → output, where H ∈ `routingAssetKeys` = **{USDG, WETH}**, an explicit allowlist.
  - H may not be the input or the output, so there are no cycles.
  - Both hops must be eligible edges.
- **Nothing longer:** `maxHops` is 1 or 2, and there is no graph search.
- **De-duplication:** duplicate market ids count once, and route ids are unique.

**Route properties** (objective only):
- hop count
- combined fee `1 − Π(1 − fee_i)`, in ppm. The kept share is floored, so the combined fee rounds up (conservative)
- bottleneck TVL (the smallest market TVL along the route; null if any is unknown)
- all markets verified
- all assets canonical
- the protocols involved

**Ordering objective: `BOTTLENECK_TVL_DESC`.** Sort by the highest bottleneck TVL, then fewer hops, then lower combined fee, then id. It is stated on every result. Nothing is labelled BEST, RECOMMENDED or SAFEST.

## Indicative quotes

`engine.getTradeQuote(route, amountRaw)`:
- The route must use a single venue that declares `capabilities.quotes`. Multi-venue routes are not quoted.
- The call is bounded by `QUOTE_TIMEOUT_MS` (8 s). A timeout is a retryable failure, never an invented number.

For Uniswap v3, `QuoterV2.quoteExactInputSingle` is called **hop by hop through `eth_call`** at the snapshot block:
- **Refused unless** every market is factory-verified, VERIFIED_ONCHAIN, ACTIVE and has two canonical tokens. The quoter's simulation runs the tokens' own transfer code, so untrusted token code is never simulated.
- **Output** (`TradeQuote`, kind `INDICATIVE_QUOTE`):
  - expected output
  - effective price
  - nominal fee per hop, in that hop's input asset
  - price impact
  - gas estimate (informational)
  - quotedAt, block number, freshness, provenance
- **Price impact:** `1 − amountOut / (amountIn × Π spot_i × Π(1 − fee_i))`.
  - `spot_i` is each pool's exact `sqrtPriceX96²/2^192` at the **same block**, and fees are excluded.
  - The amount comes from the quoter's actual concentrated-liquidity swap simulation, so no constant-product assumption is involved.
- **Not included:** there is no minimum output, slippage limit, deadline or calldata. A minimum output needs a user-chosen slippage in a future execution phase.
- **Failures:** a revert (e.g. the amount exceeds the pool) is a non-retryable failure; RPC errors are retryable.

## Caches (`src/config/freshness.ts`)

| Cache | TTL | Why |
|---|---|---|
| pool list | resumable cold event index + `POOL_LIST` 10 min incremental rescans; persisted to `.cache/` (not committed) | new pools are rare; the one-time index is the expensive part on the public RPC |
| pool identity | `POOL_IDENTITY` 24 h, persisted across processes | token0/token1/fee/factory origin are immutable per v3 pool; re-verified onchain after 24 h |
| pool state (primary) | one snapshot per block, reused ≤ `POOL_STATE` (15 s) | price and liquidity change with every swap |
| pool state (secondary) | `POOL_STATE_SECONDARY` 5 min, each value labelled with its block | pools with a non-registry token: never default, never an edge, never quoted |
| route graph | not cached; derived per request | always consistent with the markets |
| quotes | `QUOTE` 5 s per (route, amount, block) | quotes are block-specific |
