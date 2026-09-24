# Asset Intelligence (Phase 5 product read API)

`src/product/`. It answers the product question *"I own this asset. What can I actually do with it?"* for a future frontend. It is read-only: nothing here signs, approves, builds calldata or sends a transaction.

```
OpportunityEngine (raw, Phases 2–4) ── getOpportunities({eligibility: "ALL"}) at one pinned block
   │  snapshot (15 s TTL): raw opportunities by primary asset + trade graph + markets
   ▼
AssetIntelligenceService (src/product/service.ts) ── projection, no protocol logic
   │  classifyOpportunity / classifyRoute / classifyQuotedRoute   → usability (product-usability.md)
   │  opportunityCard / routeCard                                 → ProductCard (neutral labels)
   │  rankCards per subcategory (and per trade target)            → ranking (product-ranking.md)
   │  capabilities, counts, empty states, data quality, freshness
   ▼
AssetIntelligence · PortfolioIntelligence · CoverageRow[]  (src/product/types.ts)
```

The raw `Opportunity` stays the source of truth. A product card is a projection and always lists the raw opportunity ids behind it (`sourceOpportunityIds`). Route cards list one raw TRADE opportunity per hop.

## Service API
A future HTTP route can call these methods directly. No HTTP server is part of Phase 5.

| Method | Returns |
|---|---|
| `getAssetIntelligence(asset, { mode?, tradeTarget?, tradeAmount?, holding? })` | one asset. `asset` is a registry key (`4663:0x…`) or an address, never a symbol |
| `getCategory(asset, "TRADE" \| "EARN" \| "BORROW" \| "LIQUIDITY", opts)` | one intent of the same view, or `null` |
| `getPortfolioIntelligence(wallet, { mode? })` | every held canonical asset (with the holder's balance) plus supported/unsupported value |
| `getCoverage()` | one `CoverageRow` per canonical asset ([coverage.md](coverage.md)) |
| `getRawOpportunities(query)` | RAW mode: the engine's untouched output |

## Modes
- **RAW** (`getRawOpportunities`): the Phase 2–4 engine output, unchanged.
- **PRODUCT** (default): only ACTIONABLE, LIMITED and INFORMATIONAL cards. Trade routes are capped per target (below).
- **DEBUG**: PRODUCT plus `excluded[]`, which holds every HIDDEN_BY_DEFAULT and UNAVAILABLE card with its reasons. Trade routes are not capped.

## Categories
Top-level categories are user intents. They are never ranked against each other:

| Product category | Subcategories (ranking unit) | Raw categories |
|---|---|---|
| TRADE | TRADE | TRADE (as routes, see below) |
| EARN | LEND, VAULT, FIXED_YIELD, YIELD | LEND, VAULT, FIXED_YIELD, YIELD |
| BORROW | COLLATERAL | COLLATERAL ("borrow X against this asset") |
| LIQUIDITY | LP | LP |

Order is fixed: TRADE, EARN, BORROW, LIQUIDITY. The raw category is kept as `rawCategory`.

## Action labels
Labels are neutral and describe the action only: "Supply USDG", "Deposit USDG", "Buy PT-NVDA-15OCT2026 with NVDA", "Buy YT-…", "Borrow USDG against NVDA", "Provide NVDA liquidity", "Trade NVDA → USDG". Words such as best, safest, safe, guaranteed, risk-free and recommended never appear, except in negations such as "Not guaranteed" and "Not a recommended amount". A test and the live validation both scan the whole output for these words.

External strings (vault names, PT/YT symbols, API labels) are sanitized by the adapters before they reach a card. The CLIs also strip control and bidi characters when printing.

## Card identity
`cardId` is deterministic:
- opportunity cards: `${protocol}:${subcategory}:${venue.kind}:${venue.id}:${primaryAsset}:${output | borrowAsset | -}`
- route cards: `route:${route.id}`, and `route.id` includes every market id

Two raw opportunities with the same cardId are the same user action and become one card, with both raw ids listed. Different fee tiers are different pools, so they never merge.

## Trade display
- **No amount:** route information only (path, markets, fee, bottleneck liquidity, verification, `volume24h: "UNKNOWN"`). There are no quotes. Routes go to the default targets `PRODUCT_TRADE_TARGET_KEYS` = USDG and WETH (`src/config/trade.ts`). These are the two deepest hubs measured live: USDG has 127 active v3 pools ≥ $50 against 76 counterparts, and WETH/USDG is $18.9M. Every other destination is counted in `otherTradeDestinations` and can be requested with `tradeTarget`.
- **Explicit amount:** needs both `tradeTarget` and `tradeAmount` (a decimal string of the asset). Each route to that target gets an INDICATIVE quote (`guarantee: "NONE"`, no minimum output), and the routes are ranked by expected output. An amount without a target is rejected. Amounts are never inferred from a balance, and a portfolio view never quotes.
- **Per-target cap:** `PRODUCT_MAX_ROUTES_PER_TARGET = 5` in PRODUCT mode. This is a UX limit, not a quality judgement. The remainder is reported as `moreRoutes: [{ target, shown, total }]`. DEBUG mode and the raw APIs keep every route. Live NVDA had 30 visible routes to its two targets (2026-09-24).

## Stock Token display
Phase 1 semantics are unchanged. `balance.rawBalance` and `displayBalance` are the ERC-20 token balance. `balance.stock` adds `uiMultiplier` and the share-equivalent, for display only. Pendle's share-unit accounting (the PT/LP accounting unit) is a property of the Pendle card (`fixedYield.accountingUnit`, rate `unit: "accounting:<key>"`). It never changes the balance.

## Pendle PT display (`fixedYield`)
A PT card shows:
- the implied APY: a MetricView with basis IMPLIED and unit `accounting:<key>` when the market's accounting unit is not the token
- maturity, seconds and days to maturity
- the accounting unit with a description
- the PT discount
- `conditions`: the rate is realised only if bought at this price and held to maturity, and it is not guaranteed; the entry price includes swap fees and slippage; the redemption terms, when the adapter supplies them
- for Stock Token PT, the rate's `unit` is the accounting unit, not the token, with the note ACCOUNTING_UNIT_NOT_TOKEN

Implied APYs are compared only within the same unit.

## Borrow capacity (`borrowCapacity`, with a holding only)
- `kind: "THEORETICAL_LIMIT"`: the protocol's maximum borrow at LLTV for the holder's full balance. It is computed with exact integer math through the Phase 2 user context (`buildPortfolioOpportunity`).
- `recommendedBorrow: null`, always. No safety buffer is modelled (open question P2-5).
- `caveat`: a position of this size is liquidatable on the next adverse move.

## Summary, counts and empty states
- `summary.capabilities`: `canTrade / canEarn / canBorrowAgainst / canProvideLiquidity` are true only when an **ACTIONABLE** card exists for that intent. `detail[intent]` is one of ACTIONABLE, LIMITED_ONLY, INFORMATIONAL_ONLY or NONE. Informational-only is not a capability; for example, a collateral market with nothing to borrow is not a borrow capability.
- `summary.counts`: discovered, verified, actionable, limited, informational, hidden and unavailable are counted separately over the asset's raw opportunities (actionable + limited + informational + hidden + unavailable = discovered). `hiddenByReason` counts every reason of every hidden or unavailable item. Reasons are not exclusive, so one item can count under several reasons.
- `summary.protocols`: protocols with an ACTIONABLE or LIMITED card. `allDiscoveredProtocols` lists every protocol that returned anything for the asset.
- `emptyStates`: UNKNOWN_ASSET, NON_CANONICAL_ASSET, UNPRICED, NO_BALANCE, NO_OPPORTUNITIES, NO_USABLE_OPPORTUNITIES and ADAPTERS_UNAVAILABLE are explicit. The API never returns an unexplained empty list.

## Data quality and freshness
- `dataQuality.status`:
  - UNKNOWN: every adapter is unavailable
  - PARTIAL: an adapter is PARTIAL or UNKNOWN (reason `${PROTOCOL}_UNAVAILABLE` or `_PARTIAL`), or the price is unavailable
  - STALE: a stale critical value
  - otherwise COMPLETE
- `freshness`: `oldestCriticalDataAt`, `newestDataAt`, `staleSources[]` and `evaluatedAt`. The critical values are the headline metric, the liquidity and the TVL of every visible card. Ages are evaluated when the response is built. A cached view gets a new `evaluatedAt`. Its stale list can lag by at most the snapshot TTL (15 s).
- `sources`: compact `{ provider, type }` per card. Full provenance stays on the raw opportunity.

## Portfolio intelligence
- The wallet address goes only to the Phase 1 balance reader (onchain `balanceOf`). It is never sent to a protocol API, logged, persisted or put in metrics. It is echoed back only to the caller.
- Every held canonical asset gets a full AssetIntelligence with its holding (balance, borrow capacity).
- Values:
  - `supportedAssetValueUsd`: held value with at least one ACTIONABLE or LIMITED intent
  - `unsupportedAssetValueUsd`: held value with none, plus native ETH and non-canonical tokens
  - `pricedValueUsd` and `unpricedAssetCount`: from Phase 1
- No balance is ever quoted automatically.

## Open positions (`PortfolioIntelligence.positions`)
Positions come from the engine's `getUserPositions`, which reads onchain at the snapshot block (Morpho `position(id, user)` and vault `balanceOf`; Pendle PT/YT/LP balances). The wallet reaches only the chain reader, never a protocol API.

Each `PositionView` carries:
- the supplied, borrowed and collateral amounts, in tokens and USD
- Morpho's health factor, LTV and the market's liquidation LTV
- `liquidatable`, evaluated with integer math at the block
- the maturity (PT/YT/LP)
- the venue address
- warning codes

Positions with debt are listed first.

## Trade targets and borrowable-now
- `tradeTargets`: every asset reachable from this one through verified routes (DIRECT or ONE_HOP), with its symbol. The web target picker offers only these. An asset with no route gets an explicit message and no picker.
- `borrowCapacity.borrowableNow` = min(protocol limit at LLTV, the market's available liquidity), compared exactly in integers, with `cappedBy` set to PROTOCOL_LIMIT or MARKET_LIQUIDITY. It is still at the liquidation threshold and is not a recommendation.

## Protocol app links (`protocolApp`)
A card links to the protocol's own app only when the app's host is in the protocol's verified `linkHosts` (`src/config/protocols.ts`) and passes `toTrustedLink`.

| Host | Source (2026-09-24) |
|---|---|
| app.morpho.org | linked from morpho.org, the verified domain of github.com/morpho-org |
| app.pendle.finance | linked from pendle.finance, the verified domain of github.com/pendle-finance |
| app.uniswap.org | named in the github.com/Uniswap/interface README |

Links go to the app's home page, because chain-specific deep-link formats are not verified. A route through markets of different protocols gets no link.

## Caching
- The snapshot is the engine output at one block. It has a 15 s TTL (`CACHE_TTL_MS.PRODUCT_SNAPSHOT`), which is shorter than the adapter and price TTLs below it, so the product layer never extends their freshness.
- View cache keys are `chainId | asset | mode | tradeTarget | tradeAmount | holding | snapshot time`. Views with a holding are not cached.

## Observability (`src/product/metrics.ts`)
In-memory counters and timings (p50/p95/max):
- adapter latency
- asset, portfolio and coverage latency
- projection latency
- quote latency by route kind
- discovered, actionable, limited and hidden counts
- hidden by reason
- cache hit and miss

Labels must match `^[A-Za-z_][A-Za-z0-9_:-]{0,48}$`, and hex-like values are rejected. Addresses, balances and amounts cannot be recorded.

## CLIs
```bash
pnpm asset NVDA [--json] [--debug]            # what can be done with NVDA
pnpm asset NVDA --to USDG --amount 1          # indicative quotes for exactly 1 NVDA → USDG
pnpm portfolio:view --address 0x… [--json]    # per held asset (address not persisted)
pnpm coverage [--json]                        # coverage matrix
pnpm validate:intelligence                    # live Phase 5 checks
```

## Performance (live, public RPC, 2026-09-24)
| Step | Time |
|---|---|
| engine snapshot (3 adapters, 5,449 raw opportunities) | ≈ 8.3 s |
| asset view on a warm snapshot (NVDA, includes Price Service call) | ≈ 0.4–2.5 s |
| asset view, cached | 0 ms |
| NVDA → USDG, 1 NVDA, 14 routes quoted sequentially | ≈ 5.4 s (quote p50 ≈ 0.19 s direct / 0.37 s one-hop) |
| coverage, 197 assets (snapshot warm) | ≈ 0.45 s |
| portfolio view, 3 held assets | ≈ 4 s |

Quotes run sequentially to respect the public RPC limit (about 1 req/s sustained for heavy calls). A keyed provider can parallelise them.
