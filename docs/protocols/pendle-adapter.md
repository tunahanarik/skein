# Pendle adapter

`src/protocols/pendle/`. Read-only. It implements `OpportunityAdapter`, and the engine gained no Pendle-specific code. The semantics are in [pendle-semantics.md](../pendle-semantics.md).

| File | Role |
|---|---|
| `constants.ts` | Addresses from the official `deployments/4663-core.json`, each re-verified live by `pnpm validate:pendle`. Also minimal read-only ABIs. |
| `onchain.ts` | Discovery (logs), identity (three dependent multicall rounds), state (one multicall) and balances. |
| `api.ts` | Pendle API client: one endpoint, zod-validated. The URL is built from a fixed base + chain id + checksummed address. |
| `math.ts` | bigint `expm1Wad` (implied APY from the log rate) and a relative-difference check. |
| `normalize.ts` | Pure: market inputs → FIXED_YIELD, YIELD and LP opportunities. |
| `adapter.ts` | Caches, orchestration, per-market isolation and positions. |

**Capabilities:**

| Capability | Value | Note |
|---|---|---|
| `discovery` | true | |
| `assetFiltering` | false | the engine filters |
| `userPositions` | true | |
| `singleOpportunity` | true | |
| `execution` | false | |

## Discovery: onchain, nothing hardcoded

1. Scan `CreateNewMarket(market, PT, scalarRoot, initialAnchor, lnFeeRateRoot)` on `marketFactoryV6`.
   - The first scan covers `fromBlock` (default 0) to head.
   - Later scans resume at `lastScannedBlock + 1`.
   - The factory's logs are sparse: 13 logs, one request, about 190 ms.
   - `ChainReader.getLogs` bisects ranges the provider rejects as too large, up to 2^16 sub-ranges. Any other failure throws; there is never a partial list.
2. Verify every market with these identity checks. All must be `true`; `null` means unreadable.
   - `factory.isValidMarket(market)`
   - `yieldContractFactory.isPT(PT)` and `isYT(YT)`
   - `PT.SY() == market SY`, `PT.YT() == market YT`, `YT.PT() == market PT`, `YT.SY() == market SY`
   - `PT.expiry() == market.expiry()`
   - PT and SY decimals equal
3. The Pendle API is **not** used for discovery. It lists 9 of the 13 markets. The 4 unlisted ones are found onchain, including the USDG market `0xC2B8…5f4c` with about $49.8k of liquidity.

## Per-run reads

**Onchain** (one multicall at the context block, per market):
- `_storage()`: pool totalPt, totalSy, lastLnImpliedRate
- LP `totalSupply()`, `isExpired()`
- `SY.exchangeRate()`, `SY.paused()`, `SY.previewRedeem(yieldToken, 1 SY)` (only when the yield token is in `getTokensOut()`)
- `RouterStatic.getPt/Yt/LpToAssetRate(market)`

**API:** `GET /v1/4663/markets/{address}`.
- This is the only endpoint with `dataUpdatedAt`.
- One request per **non-expired** market, 4 in parallel. It is an N+1 pattern, bounded by the market count (7 requests today).
- **Expired markets are not requested**, because none of their API fields are used.
- A **404** means "not indexed by Pendle". That is an answer, not a failure: it is cached for the state TTL and gives `protocolListed = false` with a `UNLISTED_MARKET` warning.

**Prices:** yield-token USD comes from the Phase 1 Price Service through `priceCanonicalAssets`, which passes the onchain `uiMultiplier` exactly as Phase 1 defines. Pendle's own USD prices are never used.

## Caches (separate; TTLs in `src/config/freshness.ts`)

| Cache | Content | TTL | On failure |
|---|---|---|---|
| market list | discovered markets + last scanned block | `PROTOCOL_MARKET_LIST` (10 min), incremental | last list served for ≤ `PROTOCOL_STATE_STALE_FALLBACK` (6 h), PARTIAL, `MARKET_DISCOVERY_DEGRADED`; with no list the adapter fails (engine: UNKNOWN for Pendle only) |
| config | per-market identity + checks | `PROTOCOL_MARKET_CONFIG` (1 h); only fully readable identities are cached | retried next run |
| API state | per-market API response | `PROTOCOL_MARKET_STATE` (60 s) | last good response served for ≤ 6 h, marked stale, PARTIAL; with none, onchain figures only (IMPLIED_APY still published) |
| not indexed | 404 answers | 60 s | — |

Pool state, SY rate and router rates are never cached, and failures are never cached.

## Opportunities per market

Each market produces three opportunities. Their ids are `4663:pendle:{FIXED_YIELD|YIELD|LP}:pendle-market:{market}`.

What the three share:
- **Primary asset / entry:** the yield token if it is in `SY.getTokensIn()`, otherwise the first input token.
- **EntryRequirement:** `SY_CONVERSION_REQUIRED`.
  - Steps: WRAP (verified by `getTokensIn`), then SWAP or ADD_LIQUIDITY. The second step is verified only when identity is verified, the market is not expired, the SY is not paused and, for swaps, the pool has PT.
  - `singleTransactionAvailable` = true, citing the router from the deployment file and the documented router functions. This is **not simulated**, and no route or calldata is built.
- **No readable input token** → `UNKNOWN` + `ENTRY_ROUTE_UNKNOWN`, excluded by default.
- **Liquidity:** `liquidityKind = POOL_LIQUIDITY`. `availableLiquidity` = `tvl` = `(totalSy + totalPt × ptToAssetRate / exchangeRate) × previewRedeem(1 SY)` in yield-token units, then USD through the Price Service. The API's `liquidity.usd` is kept in `details.apiLiquidityUsd`.
- **Relationships:** SY `WRAPS` the yield token; PT `PRINCIPAL_COMPONENT_OF` SY; YT `YIELD_COMPONENT_OF` SY; PT `REPRESENTS_CLAIM_ON` the accounting asset; LP `LP_SHARE_OF` PT and SY. See [asset-relationships.md](../asset-relationships.md).
- **Verification:**
  - An API-vs-chain identity conflict (PT, YT, SY, expiry) → `CONFLICT`.
  - A failed identity check → `UNVERIFIED`.
  - Otherwise, the weakest of the asset statuses and the yield statuses.
- **Canonical:** `allAssetsCanonical` requires the yield token and all input tokens to be canonical, **and** PT to resolve to a canonical asset through its relationships. PT, YT, SY and LP are protocol-issued and never `canonical` themselves.
- **Listing:** `risk.protocolListed` = API `isWhitelistedPro`, or false on a 404.

What differs by category:

| Category | Output | Yields | Specific warnings |
|---|---|---|---|
| FIXED_YIELD | PT | `IMPLIED_APY` (onchain) + `UNDERLYING_APY` (reference) | `IMPLIED_RATE_NOT_GUARANTEED` |
| YIELD | YT | `YIELD_EXPOSURE_APY` + `UNDERLYING_APY` | `YIELD_TOKEN_DECAYS_TO_ZERO` |
| LP | LP token (market) | `NET_APY` + `COMPONENT_APY` (swapFee, lpReward) + `REWARD_APY` (PENDLE, when > 0) + `UNDERLYING_APY` | — |

Other warnings: `ACCOUNTING_UNIT_NOT_TOKEN`, `UNDERLYING_YIELD_SOURCE_UNCLEAR`, `UNDERLYING_UNVERIFIED`, `EXPIRED_MARKET`, `PROTOCOL_PAUSED`, `UNLISTED_MARKET`, `STALE_PROTOCOL_DATA`, `NON_CANONICAL_ASSET`, `LOOKALIKE_TOKEN`, `DATA_CONFLICT`, `MARKET_UNVERIFIED_ONCHAIN`, `ZERO_LIQUIDITY`, and `LOW_LIQUIDITY` (added by the engine).

Symbols read from chain go through `sanitizeSymbol`: only letters, digits, space and `. _ - + / ( )` are kept, max 32 characters. API strings are display-only.

## Positions

**Positions are included.** They are interpretable from onchain reads alone. PT, YT and LP `balanceOf(wallet)` are read in every discovered market, expired ones included (matured PT stays redeemable).

**Value:**
```
balance × RouterStatic rate / 1e18 (accounting units) × 1e18 / SY.exchangeRate × previewRedeem(1 SY)
```
- The result is in yield-token units, converted to USD through the Price Service.
- It is a spot value, before exit fees and slippage.

**Kinds:** `PRINCIPAL_TOKEN`, `YIELD_TOKEN`, `LIQUIDITY_POOL`. `shares` holds the raw balance, and `maturity` is `{ at, expired }`.

**Excluded, with a warning** (`REWARDS_MAY_BE_INCOMPLETE`):
- unclaimed YT interest
- LP swap/PENDLE rewards

The wallet address is **never** sent to the Pendle API.

## Live validation (`pnpm validate:pendle`, 2026-09-24)

**Deployment and discovery:**
- All 5 deployment contracts have code.
- **Discovery = independent log scan:** 13 of 13. The API list is a subset (9), and 4 markets are onchain-only.

**Representative markets, re-read independently with raw viem at the adapter's block:**

| Market | Result |
|---|---|
| USDG `0xC2B8…` (unlisted) | identity 9/9 checks. Implied APY adapter 3.499995 % = exp(lnRate) − 1, Δ 2e-14 %; API Δ 6e-5 %. Pool $49,824 onchain vs API $49,817. |
| Stock Token NVDA `0x206a…` | identity 9/9. Implied 7.288749 %, Δ 0. SY rate == uiMultiplier. Pool $152,869 vs API $152,830 (Δ 0.03 %). |
| Structurally different: expired USDG-TEST `0x78Eb…` (404 in the API) | EXPIRED, no yields, canEnter false, excluded by EXPIRED. PT rate 1.0. |

**Default view and positions:**
- Default view: 15 of 39 shown. Hidden: EXPIRED 18, UNVERIFIED_ASSET 21 (sNET, SHROOM, sNUKE, microduck).
- Positions: an EOA PT-NVDA holder (hashed). The PT balance matches an independent `balanceOf`, and the value is in NVDA and USD.

**Performance:**
- **Pendle cold:** about 3.1–5.2 s. Breakdown: discovery 0.19 s, identity 0.62 s, state + API 1.5–3.7 s, prices 0.4–1.1 s.
- **Pendle warm:** about 1.4 s.
- **Combined engine** (Morpho + Pendle, warm registry): about 1.3–1.4 s warm, 5–7.5 s cold.

## Limitations

- Stock Token YT/underlying APY from the API excludes multiplier growth (`UNDERLYING_YIELD_SOURCE_UNCLEAR`); no independent APY is computed without archive history.
- USDG underlying yield (external reward) is not verifiable onchain.
- LP components from the API do not add up to the headline in general. They are shown as components, never summed by us.
- `singleTransactionAvailable` cites documentation and deployment; nothing is simulated (read-only phase).
- The engine reports `LOW_LIQUIDITY` as an advisory only. A $1 dust market (onchain-only, 404 in the API) remains in the default view with that advisory; see open questions.
