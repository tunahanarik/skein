# Opportunity Engine

`src/opportunities/engine.ts`. It answers: *"I own asset X. What verified DeFi opportunities exist for it on Robinhood Chain?"* It is read-only and has no execution path.

```
Portfolio (Phase 1) ─┐
                     ▼
OpportunityEngine ── context(): registry + latest block (every onchain read in a run is pinned to it)
   │  run(adapter)  ← failure isolation: a throwing adapter becomes status UNKNOWN + ADAPTER_FAILED
   ├── MorphoAdapter            (Phase 2 reference adapter)
   └── <future adapters>        (Pendle, Uniswap, Spark … — no engine change needed)
   │  merge → de-duplicate ids (DUPLICATE_OPPORTUNITY_ID) → filter → sort
   ▼
EngineResult<T> { data, status COMPLETE|PARTIAL|UNKNOWN, adapters[], warnings[], blockNumber, generatedAt, timingsMs }
```

The engine contains **no protocol logic**. It never reads `Opportunity.details`. A second, toy adapter in the integration tests plugs in without any engine change.

## API
| Method | Returns |
|---|---|
| `getOpportunities(query?)` | every opportunity from every discovery-capable adapter |
| `getAssetOpportunities(assetKey, query?)` | opportunities whose **primary asset** is `assetKey` (`4663:<address>`, never a symbol) |
| `getUserPositions(wallet)` | existing positions (separate from opportunities) |
| `getPortfolioOpportunities(portfolio, query?)` | for each canonical asset held: its opportunities plus user-aware context |

## Opportunity model (`src/model/opportunity.ts`)
- **Identity:**
  - `id = chainId:protocol:category:venueKind:venueId` (deterministic)
  - `primaryAsset` is the asset the holder uses
  - `inputAssets` / `outputAssets` / `collateralAssets` / `borrowAssets` complete the picture
- **Assets:** an `AssetRef` is joined to the Phase 1 registry by address. `canonical` is true only for registry assets. The symbol is whatever the source reported (possibly a look-alike).
- **Measured values:** `Measured<T>` = `value`, `origin` (SUPPLIED or COMPUTED), `source`, `observedAt`, `freshness`, `verification`, and a `formula` when computed. Missing values are `null`; nothing is filled with a placeholder 0.
- **Other fields:**
  - `yields: YieldMetric[]` (see semantics below)
  - `tvl`, `availableLiquidity` (token amount + USD via Phase 1 prices), `utilization`
  - `liquidation` (LLTV, incentive factor, price authority, protocol collateral price)
  - `term`, `contracts`, `risk` (objective facts, `Known<T>` = value or explicit unknown)
  - `details` (protocol payload)
  - `conflicts`, `warnings`, `provenance`, `freshness`, `verificationStatus`

### Yield semantics
| Type | Side | Meaning |
|---|---|---|
| SUPPLY_APY | EARN | lender's variable, compounded rate |
| BORROW_APY | **PAY** | borrower's cost; higher is worse |
| BASE_APY | EARN | organic yield, excluding incentives |
| REWARD_APY | EARN | incentive rate; `compounding: SIMPLE` when the source gives an APR |
| NET_APY | EARN or PAY | protocol-defined net figure (after fees, including rewards) |
| IMPLIED_APY | EARN | market-implied fixed rate to maturity (Pendle, later) |
| FIXED_APY | EARN | contractual fixed rate |
| LP_APR | EARN | simple fee/incentive APR |

Each metric also carries `basis` (VARIABLE / FIXED / IMPLIED), `window`, `denominatedIn` (the asset it accrues in; this matters for Pendle PTs on Stock Tokens), `label` and full provenance. **Sorting compares one metric type at a time and needs an explicit direction.** Opportunities without that metric are not ranked and are listed as `notComparable`, never treated as 0.

## Filtering and sorting (`src/opportunities/query.ts`)
- **Filters:** `categories`, `protocols`, `assetKey` + `assetRole` (PRIMARY / INPUT / COLLATERAL / BORROW / ANY), `minLiquidityUsdE18`, `minTvlUsdE18`, `verificationStatuses`, `canonicalOnly`, `protocolListedOnly`. There are no subjective filters.
- **Sorts:** `YIELD` (type + direction), `TVL_USD`, `LIQUIDITY_USD`, `UTILIZATION` (direction required). Deterministic, with ties broken by id.

## User-aware context (`src/opportunities/userContext.ts`)
`PortfolioAsset × Opportunity → PortfolioOpportunity`. This is generic: it uses only `liquidation`, `availableLiquidity` and `yields`.
- **COLLATERAL:**
  - `protocolMaximumBorrow = floor(floor(collateralRaw × price.raw / price.scale) × LLTV / 1e18)`. This is Morpho's own `_isHealthy` bound, computed in bigint with the protocol's oracle price.
  - `protocolMaximumBorrowLiquidityCapped` = the same, capped at available liquidity.
  - Both carry the caveat that a position at that size is **at** the liquidation threshold and that this is not a safe amount. A safety-buffer model is deliberately not built yet.
- **LEND / VAULT:** `suppliable` = the holding (token + USD) and the opportunity's own EARN metric. There are no projections.
- USD values come from the Phase 1 Price Service only.

## Status and failure isolation
| Level | Behaviour |
|---|---|
| API field missing | the value is `null`, and the opportunity is kept |
| one malformed API item | dropped and reported as an issue; status PARTIAL |
| one market with unreadable params/totals | only that market is dropped or degraded |
| protocol API down, last-good state ≤ 6 h | stale state is served, PARTIAL, `STALE_PROTOCOL_DATA` |
| protocol API down, no cache | the adapter fails; the engine returns that adapter as UNKNOWN (`ADAPTER_FAILED`) and other adapters continue |
| every adapter failed | UNKNOWN |

## Performance (live, public RPC, 2026-09-24)
Full discovery takes **3.0–3.5 s** inside the adapter:
- Morpho API: ~0.9–1.6 s
- onchain reads (params/totals/oracles/vaults): ~1.0 s
- Price Service: ~0.9–1.1 s
- normalizing 586 opportunities: ~30–50 ms

It is about 4.4–5.4 s end-to-end including the registry. On repeat runs the config cache skips the 274 `idToMarketParams` reads. Portfolio → opportunities for a 166-asset wallet takes ~2.3 s.
