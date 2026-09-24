# Morpho adapter

`src/protocols/morpho/`. This is the reference adapter. Everything below was **re-verified live on 2026-09-24** before coding (Phase 2 step 1).

## Deployment re-verification

| Item | Result | Source |
|---|---|---|
| Chain | `eth_chainId` 4663 | live |
| Morpho (Blue) | `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`, 15,582 B of code | [docs addresses (Robinhood Chain tab)](https://docs.morpho.org/developers/contracts/addresses.md); `morpho-org/sdks` `packages/morpho-ts/src/addresses.ts` (`ChainId.RobinhoodMainnet = 4663`, identifier `"robinhood"`, deploy block 286) |
| AdaptiveCurveIrm | `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` | same |
| VaultV2Factory | `0x0FBad98595b0186dA120E41f77C102beb49f803c`; used as `isVaultV2(vault)` for every published vault | same |
| Official API | `https://api.morpho.org/graphql`; `chains` includes `{id:4663, network:"Robinhood Chain"}` | live |
| Market discovery | API `markets(where:{chainId_in:[4663]})`, 200 per page | live: 277 markets |
| Vault discovery | API `vaultV2s(where:{chainId_in:[4663]})`; no MetaMorpho V1 on this chain | live: 38 vaults |
| Oracle structure | MorphoChainlinkOracleV2 (Chainlink token feed ÷ USDG feed); "Unknown" custom oracles; a MetaOracle on the USDe market | Phase 0 + live checks |
| API vs chain | identity of all markets checked onchain every run; representative totals and IRM-derived APYs matched exactly in validation | live |

**Changes vs Phase 0:**
- The docs addresses URL moved: `…/get-started/resources/addresses` returns 404; `…/developers/contracts/addresses.md` works.
- **Double-applied multiplier oracles:** 4 markets, identical to 4 of the 6 oracles Phase 0 found: NVDA `0xED29…`, AAPL `0xD625…`, GOOGL `0x12Ec…`, MSFT `0xcb9a…`. SPCX and COIN have multiplier exactly 1.0, so double application is **not detectable** there.
  - A first version of the classifier used a 1 bp tolerance and mislabelled GOOGL (multiplier 1.00019) as consistent. The classifier now matches the ratio against the structures 1 / m / P_loan / m×P_loan at 1 ppm (same-feed matches agree to ~1e-17), and labels anything unmatched INCONCLUSIVE.
  - One NVDA market (`0xbe3a5355…`, ratio 1.00103) is INCONCLUSIVE.
- **New:** 49 Stock Token markets use oracles that value USDG at exactly **$1** (ratio = USDG/USD 1.00009). 7 of them have liquidity. Recorded as `oracle.loanPegAssumed = true`.
- **The API's BigInt scalars** come back as JSON numbers when ≤ 2^53 and as strings above that. The schema accepts only safe integers as numbers, so precision can never silently be lost.

## Market → opportunities
| Morpho market (loan L, collateral C) | Emits |
|---|---|
| normal market | **COLLATERAL** (primary C; input C; borrow L; BORROW_APY is PAY) and **LEND** (primary L; SUPPLY_APY is EARN) |
| IRM = 0 or collateral = 0 (idle) | nothing (`MARKET_SKIPPED`) |
| params unreadable / not created onchain | nothing (`MARKET_UNVERIFIED_ONCHAIN`) |

BORROW is not a separate opportunity: in Morpho, borrowing L requires this market's C, so it is the same action seen from the collateral holder.

Vault V2 (factory-verified only) → **VAULT** (primary = vault asset; NET_APY and BASE_APY).

## Source of every field
| Field | Source | Origin |
|---|---|---|
| marketId | API; **re-hashed** from onchain params (`keccak256(abi.encode(MarketParams))`) | SUPPLIED + checked |
| loan / collateral token, oracle, IRM, LLTV | **onchain `idToMarketParams`** (API compared → DATA_CONFLICT) | SUPPLIED (chain) |
| total supply / borrow | **onchain `market(id)`** at the pinned block (API compared, >2 % → DATA_CONFLICT) | SUPPLIED (chain) |
| available liquidity | supply − borrow (onchain) | COMPUTED |
| utilization | borrow / supply (onchain, Fixed18) | COMPUTED |
| collateral posted | API `state.collateralAssets` (Morpho keeps no onchain total) | SUPPLIED (API) |
| supply / borrow / net APY | API `state.*Apy` (float → Fixed18 once) | SUPPLIED (API) |
| rewards | API `state.rewards[].supplyApr / borrowApr` → REWARD_APY (SIMPLE) | SUPPLIED (API); **may be incomplete** (Phase 0: Merkl campaigns missing) |
| listed, warnings | API | SUPPLIED (API) |
| oracle price | onchain `oracle.price()` | SUPPLIED (chain) |
| liquidation incentive factor | `min(1.15, 1/(1 − 0.3(1 − LLTV)))` from `Morpho.sol` | COMPUTED |
| USD values | Phase 1 Price Service | COMPUTED |
| oracle structure check | ratio = oracle ÷ (collateral USD ÷ loan USD × 10^(36+dL−dC)), matched against 1 / m / P_loan / m×P_loan at 1 ppm → CONSISTENT, DOUBLE_APPLIED, `loanPegAssumed`, INCONCLUSIVE or DEVIATES | COMPUTED |
| vault totalAssets | onchain `totalAssets()` (API compared) | SUPPLIED (chain) |
| vault APY, liquidity, fees | API (no state timestamp → freshness UNKNOWN) | SUPPLIED (API) |
| positions | onchain `position(id,user)` over all markets + vault `balanceOf/convertToAssets` | SUPPLIED/COMPUTED (chain) |

**Unknown or not provided:**
- total collateral onchain (Morpho stores none)
- vault state timestamps
- rewards outside the API
- oracle source code and admin for custom oracles
- vault governance details (`parameterMutability` unknown)

## Liquidation semantics (morpho-blue v1 source + docs)
- **LLTV:** the maximum LTV before a position is liquidatable. Fixed and immutable per market (docs `/developers/borrow/concepts/ltv`).
- **Eligibility, as the code defines it:** `Morpho._isHealthy` is healthy iff `maxBorrow ≥ borrowed`, with
  - `maxBorrow = floor(floor(collateral × oraclePrice / 1e36) × LLTV / 1e18)`
  - `borrowed = toAssetsUp(borrowShares)`

  So a position is liquidatable iff `borrowed > maxBorrow`. The docs phrase it as "LTV ≥ LLTV"; at exact equality the code treats the position as still healthy, and **we follow the code**.
- **Oracle dependency:** collateral is valued **only** by the market's oracle (`price()`, 1e36-scaled, loan units per collateral unit). Our Price Service is not what the protocol uses, which is why the user-aware maximum uses the oracle price, and why a wrong oracle (for example a double-applied multiplier) changes real borrowing limits.
- **Debt valuation:** in loan-token units. Shares convert with virtual shares (1e6) and virtual assets (1); debt rounds **up**, supply rounds **down**.
- **Incentive:** LIF = min(1.15, 1/(1 − 0.3 × (1 − LLTV))). The whole bonus goes to the liquidator.
- **Health factor:** Morpho's docs define `HF = collateral × oraclePrice / 1e36 × LLTV / borrowed`. We compute exactly that, onchain-sourced, and label it "Morpho health factor definition". `ltv` = borrowed / collateral value is labelled application-derived. No other risk ratio is invented.

## Caches
- **config:** onchain-verified params, which are immutable. Only real markets are cached; a not-yet-created id is not.
- **state:** Morpho API markets + vaults, 60 s; last-good fallback up to 6 h, marked PARTIAL + `STALE_PROTOCOL_DATA`.
- Onchain totals, oracle prices and vault totals are never cached.

## Privacy
User positions are found onchain by scanning `position(id, user)` across known markets and `balanceOf(user)` across verified vaults. **The wallet address is not sent to the Morpho API.** Live validation compares against the API only for a public borrower taken from the API's own `marketPositions` list.
