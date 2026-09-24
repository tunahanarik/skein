# Trade opportunities

Phase 4 answers *"I own asset X. Where can I trade it on Robinhood Chain?"* It is read-only: there are no swaps, approvals, signatures, permits, calldata or transaction submission.

The generic model is `src/model/trade.ts`. It is protocol-independent; the Uniswap adapter is one producer of it.

## Three separate concepts

| Concept | What it is | Carries an amount? | Where |
|---|---|---|---|
| **TradeMarket** | one liquidity venue for an asset pair, e.g. one NVDA/USDG pool | no | `Opportunity.trade.market`; `engine.getTradeMarkets()` |
| **TradeRoute** | a path from input to output through 1 market (DIRECT) or 2 markets (ONE_HOP) | no | `Opportunity.trade.route` (DIRECT); `engine.getTradeRoutes(in, out)` |
| **TradeQuote** | an amount-specific INDICATIVE estimate for one route at one block | yes, explicit | `engine.getTradeQuote(route, amountRaw)` |

These are never merged:
- A market has no "expected output".
- A route has no price impact.
- A quote exists only for an explicit amount. The portfolio view **never** quotes a whole balance.

## TRADE opportunities

Each verified market becomes **two** TRADE opportunities, one per direction, because `primaryAsset` is the asset the holder uses. For example, NVDA→USDG and USDG→NVDA through the same pool.

| Field | Content |
|---|---|
| `category` | `TRADE` |
| `primaryAsset` / `inputAssets` | the asset sold |
| `outputAssets` | the asset received |
| `venue` | the pool (kind `uniswap-v3-pool`, id = pool address) |
| `yields` | always empty. TRADE is never ranked by APY |
| `tvl` | pool TVL in USD (`amount: null` because it is a two-asset pool). Σ `balanceOf(pool)` × Phase 1 price. Unknown if either side is unpriced, never $0 |
| `availableLiquidity` (`POOL_LIQUIDITY`) | the pool's balance of the **output** token. Upper bound of one swap's payout, not executable depth |
| `lifecycle` | ACTIVE; `MARKET_INACTIVE` if the pool has no in-range liquidity or is uninitialized; `STATE_UNKNOWN` if unreadable |
| `entry` | DIRECT, one SWAP step, `verified` when the origin is verified and the market is ACTIVE. Descriptive only |
| `trade.market` | fee (ppm, STATIC/DYNAMIC), DEX price + inverse, liquidity (TVL, reserves, active L), state, origin, verification, provenance |
| `trade.route` | the DIRECT route from `primaryAsset` |
| `details` | venue payload (`UNISWAP_V3_POOL`: sqrtPriceX96, tick, L, identity checks); the engine never reads it |

## Price semantics

| Kind | Source | Used for |
|---|---|---|
| `PORTFOLIO_PRICE` | Phase 1 Price Service (Chainlink / Robinhood quote × multiplier) | valuation, TVL, portfolio |
| `DEX_MARKET_PRICE` | pool state (`slot0.sqrtPriceX96`), exact bigint | trade discovery, routing, cross-checks |

The DEX price **never** replaces the portfolio price. If the two disagree by more than `MARKET_PRICE_DIVERGENCE_PCT` (2 %, `src/config/trade.ts`), the market gets a `MARKET_PRICE_DIVERGENCE` warning with both values. Neither is declared correct.

## Liquidity semantics (no universal "liquidity" number)

| Quantity | Meaning | Not |
|---|---|---|
| TVL | value of the tokens the pool holds, including uncollected LP fees and out-of-range liquidity | executable depth |
| reserves | per-token balances with USD | an order book |
| active liquidity L | Uniswap v3 in-range liquidity at the current tick | a token or USD amount |
| depth | only from an INDICATIVE quote at an explicit size | a pool attribute |

## Default TRADE eligibility

These are generic rules (`docs/opportunity-comparison.md`). A default TRADE opportunity needs:
- **Verified factory origin and structural identity.** Otherwise `INSUFFICIENT_VERIFICATION`.
- **Canonical input and output.** The routing assets USDG and WETH are canonical. Otherwise `UNVERIFIED_ASSET`.
- **A priced TVL.** Otherwise `LIQUIDITY_UNVERIFIED`.
- **TVL of at least $50.** Otherwise `DUST_LIQUIDITY`.
- **Readable, active state.** Otherwise `ENTRY_STATE_UNKNOWN` / `INACTIVE`.
- **No conflict.** Otherwise `DATA_CONFLICT`.

Everything is kept in `eligibility: "ALL"` (`--debug`).

## Comparison

TRADE is its own comparison domain ([trade-routing.md](trade-routing.md)):
- **Without a quote:** only objective market attributes (TVL, fee, hops, verification).
- **With quotes:** routes are comparable **only** for the same input asset, output asset and input amount, by expected output (`src/trade/compare.ts`). Anything else throws.

## Portfolio context

For a held canonical asset, each TRADE item gets `context.kind = "TRADE"` with:
- the held amount and USD value
- the destination
- the route kind (DIRECT)
- a note that no amount was quoted

Each portfolio group also gets `tradeDestinations: { direct, oneHop }` from the generic graph.
