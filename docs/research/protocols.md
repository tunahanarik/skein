# Protocol records

Checked 2026-09-24. Admission to `src/config/protocols.ts` requires **an official deployment source + a live onchain check**. Candidates below that bar are in `research/unverified.json`. DefiLlama (191 protocols on Robinhood Chain) was used **only** to find candidates.

Robinhood's own docs ecosystem table (recovered from the docsite bundle) lists: Lending = **Morpho** (only), stablecoin = **Paxos (USDG)**, oracle = **Chainlink**, and trading venues = Uniswap (AMM), Rialto (propAMM), Lighter (orderbook), and 0x / 1inch Fusion / LI.FI (RFQ).

---

## VERIFIED (in production config)

### Morpho
| Field | Value |
|---|---|
| Category | LEND, BORROW, COLLATERAL, VAULT |
| Deployment verified | **yes**: code + `isIrmEnabled` / `isLltvEnabled` + four markets cross-checked (morpho.md) |
| Official docs | https://docs.morpho.org/developers/contracts/addresses/ |
| Deployment source | same page + `morpho-org/sdks` `morpho-ts/src/addresses.ts` |
| Contracts | Morpho `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`, IRM `0x2BD3…0fa1`, VaultV2Factory `0x0FBa…803c`, PublicAllocator `0xCe5c…C857`, Bundler3 `0x6478…44a6` |
| API | `https://api.morpho.org/graphql`: covers 4663 (277 markets, 38 vaults) |
| SDK | `@morpho-org/blue-sdk` / `morpho-ts` (ChainId 4663) |
| Subgraph | none; the API is the indexer |
| Assets | loan: USDG (245 markets), WETH, a few Stock Tokens. Collateral: USDe, syrupUSDG, mGLO, spUSDG, WETH, 50 Stock Tokens, long tail |
| Metrics | supply/borrow APY, utilization, supply/borrow/liquidity (+USD), LLTV, oracle, warnings, listed flag, positions, vault APY/TVL/allocations; rewards through Merkl |
| Execution | Bundler3 + GeneralAdapter1, Permit2 (noted only) |
| Difficulty | low (API + SDK); the hard part is curation (listed vs unlisted, oracle review) |
| Open questions | cause of `deposit_disabled` on Steakhouse USDG; the double-multiplier oracles |

### Spark Savings (spUSDG)
| Field | Value |
|---|---|
| Category | YIELD (savings), VAULT (ERC-4626) |
| Deployment verified | **yes**: `asset()` = USDG, `totalAssets` 14.16M, `vsr` → 3.500 % APY (live) |
| Official docs | https://docs.spark.finance/products/spark-savings (spUSDG exists only on Robinhood Chain) |
| Deployment source | https://github.com/sparkdotfi/spark-address-registry/blob/master/src/Robinhood.sol |
| Contracts | spUSDG `0xde770c84FE66E063336b31737cFE9790f18c4087` (impl `0x797c58C9…5F02`); ALM proxy/controller in the registry |
| API | none found; compute onchain (`vsr`, `totalAssets`, `nowChi`) |
| Assets | USDG in, spUSDG out |
| Metrics | APY (computed from vsr), TVL (totalAssets), deposit cap (500M) |
| Difficulty | low |
| Not deployed | **SparkLend is not on 4663** |

### Pendle
| Field | Value |
|---|---|
| Category | FIXED_YIELD (PT), YIELD (YT), LP |
| Deployment verified | **yes**: all 9 listed markets match onchain (pendle.md) |
| Deployment source | https://github.com/pendle-finance/pendle-core-v2-public/blob/main/deployments/4663-core.json |
| API | `https://api-v2.pendle.finance/core/v2/markets/all?chainId=4663` (keyless) |
| Assets | NVDA, PFE, SGOV Stock Tokens; USDG (unlisted market); launchpad tokens |
| Metrics | implied APY, underlying APY, liquidity, TVL, fees, PENDLE APY (API); expiry and tokens (onchain) |
| Difficulty | low (read) |
| Open questions | Stock Token SY yield accounting vs uiMultiplier |

### Uniswap (v2 / v3 / v4)
| Field | Value |
|---|---|
| Category | TRADE, LP |
| Deployment verified | **yes** (2026-09-23 and today): factories, quoters, StateView, PositionManager all wired and live |
| Deployment source | https://github.com/Uniswap/contracts/blob/main/deployments/json/4663.json, `@uniswap/sdk-core` ≥ 7.19.3 |
| API | Trading API supports 4663 (key needed); no public subgraph endpoint |
| Data | onchain (see dex.md); GeckoTerminal/DexScreener as THIRD_PARTY for volume |
| Difficulty | medium (v4 discovery via logs, hook-aware TVL) |

### Beefy (CLM + vaults)
| Field | Value |
|---|---|
| Category | LP (managed), VAULT |
| Deployment verified | **yes**: CLM `0x1e8d576F71D5F416e7573b960fF59C4Fb77976ad` "Cow Uniswap Robinhood WETH-USDG" → strategy → pool `0x69BfaF19…d9a` (Uniswap v3 factory) |
| Deployment source | `beefyfinance/beefy-v2/src/config/vault/robinhood.json`, `beefy-api/src/data/robinhood/beefyCowVaults.json` |
| API | `https://api.beefy.finance/vaults`, `/cow-vaults` (76 Robinhood CLMs), `/apy/breakdown`, `/tvl` (key "4663", ≈ $2.96M) |
| Difficulty | low |

### Steer
| Field | Value |
|---|---|
| Category | LP (managed), VAULT |
| Deployment verified | **yes**: VaultRegistry `0x5c7d564fA5CE0e874367121E33c1ff10dB2115dC` has code; a v3 GME/USDG vault and a v4 vault read `getTotalAmounts()` |
| Deployment source | `@steerprotocol/sdk@3.8.0` `src/const/deployments/robinhood.ts` |
| API / subgraph | `api.steer.finance/getAprs?chainId=4663&dexName=uniswap`; public Goldsky subgraph `…/steer-protocol-robinhood/prod/gn` (33 vaults; v4 `totalAmount` fields are wrong, so read onchain) |
| Difficulty | medium |

### Merkl (rewards data source, not a venue)
`https://api.merkl.xyz/v4/opportunities?chainId=4663` covers 4663 with 58 live campaigns and 80 opportunities. It is the only source that shows the Steakhouse and USDe Morpho incentives. Campaign eligibility text (for example "Robinhood Users Only") must be passed through to the UI.

---

## VERIFIED ASSETS, NOT VENUES
- **syrupUSDG** `0x40858070814a57FdF33a613ae84fE0a8b4a874f7`: Maple docs + CCIP directory + onchain. It is bridged, and its APY comes from the Maple API for the Ethereum pool.
- **mGLO** `0xFEd493F38c1aAcb4EA4e6A11F8b9287849EE0096`: midas-apps/contracts + onchain. Minting is permissioned.

## LIKELY / UNVERIFIED / NOT ON 4663
See `research/unverified.json`. In brief:
- **LIKELY:** Arcadia V2 (lending pools), T3tris, D2 Finance, StonkBrokers, Fables hooks, wstETH (bridged), Lighter and Rialto (verified venues with offchain or keyed data).
- **UNVERIFIED:** Flock Credit, Spine, Native, Ripe, Gage, TermMax, Snuggle/MaxFi, Arcus, Meridian, PARE.
- **Not on 4663** (official registries checked): Aave v3, Euler v2, Dolomite, Silo v2, Compound III, Fluid, SparkLend, Paraswap.
