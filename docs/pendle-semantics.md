# Pendle semantics on Robinhood Chain

Research for Phase 3 was redone from scratch on 2026-09-24. The sources are:
- **Pendle docs:** `docs.pendle.finance/llms-full.txt`. The HTML pages are client-rendered, so this text export was read instead.
- **Pendle OpenAPI:** field descriptions from `api-v2.pendle.finance/core/docs`.
- **Live reads** at pinned blocks on chain 4663.

Evidence scripts: `pnpm validate:pendle` (live) and `docs/research/pendle.md` (Phase 0).

## The four tokens

| Token | What it is (Pendle docs) | What we verified onchain |
|---|---|---|
| **SY** (Standardized Yield) | A technical wrapper around a yield-bearing token. Users don't normally hold it directly. | `SY.yieldToken()`, `getTokensIn()`, `getTokensOut()`, `assetInfo()`, `exchangeRate()`, `paused()`. `previewDeposit` / `previewRedeem` give 1 token ↔ 1 SY for every Stock Token and USDG SY. |
| **PT** (Principal Token) | Redeems for **1 unit of the accounting asset at maturity**. It trades at a discount before maturity, and that discount is the fixed yield. | `PT.SY()`, `PT.YT()`, `PT.expiry()`. `yieldContractFactory.isPT(PT)`. After expiry `RouterStatic.getPtToAssetRate` = 1.0. |
| **YT** (Yield Token) | Receives the SY's yield until maturity. **Worth 0 at maturity.** | `YT.PT()`, `YT.SY()`, `isYT(YT)`. After expiry `getYtToAssetRate` = 0. |
| **LP** (the market token) | A share of an AMM holding PT and SY. Earns swap fees, PENDLE incentives, underlying yield on the SY part and the implied fixed yield on the PT part. | `market.readTokens()` → (SY, PT, YT); `_storage()` → pool totalPt/totalSy; `totalSupply()`; `getRewardTokens()` = [PENDLE]. |

Minting splits SY into PT + YT: `SY × index` units of each, where `index = max(SY.exchangeRate, previous index)`.

**Watermark.** If the SY exchange rate later falls below the recorded index, PT redeems for **less** than 1 accounting unit. This is surfaced on the PT → accounting-asset relationship and in the `IMPLIED_RATE_NOT_GUARANTEED` warning.

## Accounting unit: tokens or shares

`SY.assetInfo()` returns `(assetType, asset, decimals)`. `assetType` is TOKEN or LIQUIDITY.

**USDG** (`SY-USDG`):
- `assetType` = TOKEN and `exchangeRate` = 1.0.
- 1 PT redeems for 1 USDG.
- The Pendle API agrees: `pyUnit: "USDG"`, `ptEqualsPyUnit: true`.

**Robinhood Stock Tokens** (NVDA, PFE, SGOV):
- `assetType` = LIQUIDITY.
- `SY.exchangeRate()` equals the token's ERC-8056 `uiMultiplier()` **exactly**, measured at the same block:
  - NVDA 1.000775159164630595
  - SGOV 1.005101770003214918
- The Pendle API reports `pyUnit: "NVDA Shares"` and `ptEqualsPyUnit: false`.

So for Stock Tokens the accounting unit is **one underlying share**, not one token:
- 1 PT-NVDA redeems for one share's worth of SY.
- At the then-current multiplier `m`, that is `1/m` NVDA tokens.
- The implied APY is therefore measured **in shares** (it tracks the stock price), not in tokens.

The adapter records this in `details.accountingUnit`:
- `assetType`, a plain-language `description`, and `syRateEqualsMultiplier`.
- It sets `IMPLIED_APY.denominatedIn = null`, because the rate is not in token units.
- It emits `ACCOUNTING_UNIT_NOT_TOKEN`.

This does not change Phase 1 Stock Token valuation. The Price Service still values 1 NVDA token = underlying price × m. The Pendle adapter only converts accounting units to SY (`÷ exchangeRate`), SY to token (`SY.previewRedeem`), then token to USD through the Price Service.

## Yield metrics (never merged, never converted)

**FIXED_YIELD** (buy PT):
- **Metric:** `IMPLIED_APY`, EARN, basis IMPLIED.
- **Source:** **onchain**, `exp(lastLnImpliedRate / 1e18) − 1`, computed in bigint (`src/protocols/pendle/math.ts`). Pendle stores `ln(1 + implied APY)`.
- **Meaning:** the market's rate at its last trade. Pendle's docs call Fixed APY "numerically equivalent" to Implied APY. It is realised only if you buy at that price and hold to maturity. **Not guaranteed**: entry price, fees, slippage and SY redemption (depeg/watermark) all move the realised return. We never emit FIXED_APY.

**FIXED_YIELD** (PT discount):
- **Metric:** `details.ptDiscount`.
- **Source:** onchain, `1 − RouterStatic.getPtToAssetRate(market)`.
- **Meaning:** the spot discount to maturity value, before fees and slippage. It is a price, not a rate.

**FIXED_YIELD** (ROI to maturity):
- **Metric:** `details.ptRoiToMaturity`.
- **Source:** API `ptRoi`.
- **Meaning:** the return to expiry, not annualised.

**YIELD** (buy YT):
- **Metric:** `YIELD_EXPOSURE_APY`.
- **Source:** API `ytFloatingApy`.
- **Meaning:** Pendle's "Long Yield APY", the annualised YT return **if the underlying APY stays at the API's value**. It can be negative, and it is not comparable to any lending rate.

**all categories:**
- **Metric:** `UNDERLYING_APY`.
- **Source:** API `underlyingApy`.
- **Meaning:** a reference figure. It is not earned by entering the position.

**LP** (headline):
- **Metric:** `NET_APY`.
- **Source:** API `aggregatedApy`.
- **Meaning:** underlying yield + PT fixed yield + swap fees + PENDLE, **without** vePENDLE boost. `maxBoostedApy` is not used.

**LP** (components):
- **Metric:** `COMPONENT_APY` (`componentOf: NET_APY`).
- **Source:** API `swapFeeApy`, `lpRewardApy`.
- **Meaning:** parts of the headline. They do not necessarily sum to it, and are never ranked alone.

**LP** (incentive):
- **Metric:** `REWARD_APY`.
- **Source:** API `pendleApy` (only when > 0).
- **Meaning:** paid in PENDLE (`rewardAsset` = onchain `getRewardTokens()`).

Cross-checks:
- **API impliedApy vs onchain:** a gap above `PROTOCOL_RATE_CONFLICT_PCT` (1 % relative) becomes a `DataConflict`, and the onchain value is kept. Observed gap: 5e-6 relative.
- **API `liquidity.usd` vs onchain pool value:** a gap above `PROTOCOL_LIQUIDITY_CONFLICT_PCT` (5 %) is also recorded. Observed: 0.01–0.3 %.

## What is not verifiable (measured, surfaced, not resolved)

**Stock Token underlying yield.** The Pendle API reports `underlyingApy = 0` and Long Yield APY = −100 % for NVDA, PFE and SGOV. Onchain, the SY rate *is* the multiplier, and the multiplier rises when dividends are reinvested, so YT holders do accrue something. Our reading is that the API figure does not appear to include multiplier growth. We cannot measure an APY for it without history: the public RPC is not an archive node.
- The API values are published as supplied.
- They carry `UNDERLYING_YIELD_SOURCE_UNCLEAR`.
- This is recorded in open questions.

**USDG underlying yield.** 3.3 %, which the API labels `EXTERNAL_REWARD`. `SY-USDG.exchangeRate` stays 1.0, so the yield is not in SY accounting and cannot be verified onchain. It is marked `UNDERLYING_UNVERIFIED`.

## Lifecycle

- **Maturity:** `market.expiry()`, onchain and immutable.
- **Reference clock:** the **pinned block's timestamp**.
- **States:** active strictly before maturity; `EXPIRED` at or after it.

For an expired market:
- No yields are published.
- The entry steps are marked unverified.
- `canEnter` is false.
- It is excluded from the default view (`EXPIRED`) and visible with `includeReasons: ["EXPIRED"]`.

A paused SY (`paused() == true`) adds the blocker `PROTOCOL_PAUSED`.

Maturity is not a lock. Positions can be sold before maturity at market price, so `term.withdrawal` = `TRADE_BEFORE_MATURITY`.
