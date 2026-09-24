# Pendle on Robinhood Chain

Checked 2026-09-24. Reproduce with `pnpm validate:pendle` (11/11 PASS). Evidence: `research/evidence/yield/pendle_*.json` and `gh_pendle_deployments.json`.

## CONFIRMED

- **Deployment:** the official file [`pendle-core-v2-public/deployments/4663-core.json`](https://github.com/pendle-finance/pendle-core-v2-public/blob/main/deployments/4663-core.json) was added 2026-09-04.

  | Contract | Address |
  |---|---|
  | Router | `0x888888888889758F76e7103c6CbF23ABbF58F946` |
  | marketFactoryV6 | `0x544BF81c855AE84c1e8b65d5E38770898D01EeE2` |
  | yieldContractFactoryV6 | `0xa543BF1ac6441822E95eD408076bB53090a0a9d7` |
  | PENDLE | `0x5E49E1f85813F2B65858860A3FA231b4186f2e0E` |
  | pyYtLpOracle | `0x5542be50420E88dd7D5B4a3D488FA6ED82F6DAc2` |
- **API:** `https://api-v2.pendle.finance/core` (keyless) covers 4663.
  - `/v1/chains` includes 4663.
  - **`/v2/markets/all?chainId=4663`** returns 9 listed markets with `details{liquidity,totalTvl,impliedApy,underlyingApy,swapFeeApy,pendleApy,aggregatedApy,…}`.
  - Also available: `/v1/4663/markets/{addr}`, `/v2/4663/markets/{addr}/data`, `/v3/4663/markets/{addr}/historical-data` and `/v1/4663/assets/all`.
- **Onchain check of every listed market** (live 2026-09-24):
  - `readTokens()` (SY, PT, YT) equals the API
  - `expiry()` equals the API
  - `factory()` = marketFactoryV6
  - For the Robinhood markets, **`SY.yieldToken()` is the canonical Stock Token** from `/rhj/assets`.

### Active markets relevant to the router (2026-09-24)

| Market | Underlying | Expiry | Implied APY | Liquidity | TVL |
|---|---|---|---|---|---|
| `0x206a5cd00e9ffabb8ca564076b64799a78df19b9` | **NVDA** Stock Token | 2026-10-15 | 6.97 % | $159k | $185k |
| `0x892defbf…a79b` | **PFE** Stock Token | 2026-12-10 | 6.11 % | $84k | $85k |
| `0xd6e26e95…0ca0` | **SGOV** Stock Token | 2026-11-19 | 3.22 % | $23k | $23k |

The other listed markets are Pons/NetNet/NUKES launchpad tokens. Several are expired today, and sNET shows about 10,854 % implied APY. They are listed by Pendle but should be treated as high-risk long tail. A USDG market (`0xc2b89e6e…4f55f4c`, 3.50 % implied, expiry 2027-03-25) exists onchain but **is not listed** (`isWhitelistedPro/Simple = false`).

### What the numbers mean (important for display)
- A PT on NVDA is a **fixed yield denominated in NVDA units**, not in USD.
  - At maturity, 1 PT redeems for 1 unit of SY's accounting asset (NVDA).
  - The user keeps full NVDA price exposure plus an implied fixed rate in NVDA terms.
  - The UI must say "fixed yield in NVDA" and must not present it as a USD rate.
- `underlyingApy` is 0 for the Stock Token markets, even though NVDA's SY `exchangeRate()` = 1.000775 (its uiMultiplier). Whether Pendle's SY tracks the multiplier as yield is UNVERIFIED (see below).

### Which values can be displayed

| Value | Origin | Display rule |
|---|---|---|
| expiry, PT/YT/SY addresses | onchain (VERIFIED_ONCHAIN) | always |
| impliedApy, liquidity, totalTvl, swapFeeApy, pendleApy | **Pendle API** (VERIFIED_OFFICIAL_API) | show with source + fetch time; `impliedApy` labelled "implied fixed, in underlying units" |
| aggregatedApy / maxBoostedApy | Pendle API | LP view only, labelled as including PENDLE incentives |
| implied rate from `_storage().lastLnImpliedRate` | computed onchain | cross-check only |
| expired markets | onchain `expiry` | hidden from opportunities |

## LIKELY
- A Stock Token PT is the only fixed-yield opportunity on Stock Tokens that is live on 4663 today.

## UNVERIFIED
- Does the Stock Token SY treat `uiMultiplier` growth (reinvested dividends) as yield? `exchangeRate` = 1.000775 = the NVDA multiplier suggests SY accounts in share-equivalents, but the API reports `underlyingApy = 0`.
- Why the USDG market is not whitelisted.
- Pendle subgraph for 4663 (not checked; the API is sufficient).
