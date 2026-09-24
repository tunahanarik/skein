# Morpho on Robinhood Chain

Checked 2026-09-24. Reproduce with `pnpm validate:morpho`. Full tables: `research/evidence/lending/morpho_markets_4663.md` (277 markets), `morpho_markets_nonempty.md`, `morpho_vaults_4663.md`, `collateral_summary.txt`.

## CONFIRMED

### Deployment
- **Morpho (Blue) `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`**, created at block 286.
  - Official sources: [docs.morpho.org/developers/contracts/addresses](https://docs.morpho.org/developers/contracts/addresses/) (Robinhood Chain tab) and [`morpho-org/sdks` `packages/morpho-ts/src/addresses.ts`](https://github.com/morpho-org/sdks/blob/main/packages/morpho-ts/src/addresses.ts) (`ChainId.RobinhoodMainnet = 4663`).
  - Onchain: 15,582 bytes of code; `isIrmEnabled(AdaptiveCurveIrm)` = true; `isLltvEnabled(0.915e18)` = true.
- Periphery contracts with code (block 71130970):

  | Contract | Address |
  |---|---|
  | AdaptiveCurveIrm | `0x2BD3d5965B26B51814AC95127B2b80dD6CcC0fa1` |
  | ChainlinkOracleV2 factory | `0xB7c16F6F8cF531447Bf27Ca7220f981E79C9cdF2` |
  | VaultV2Factory | `0x0FBad98595b0186dA120E41f77C102beb49f803c` |
  | Public allocator | `0xCe5c1aFa115fF8b1D6913509bfc79D9AE08CC857` |
  | Bundler3 | `0x6478e9393d4C5bB4d53ee881d1DE78786A0344a6` |
  | GeneralAdapter1 | `0xc5E188541D107e8B79e43478bDE365F1406665D6` |
  | PreLiquidationFactory | `0x0B0cFa151c06d2342799267754b0a2c320C43D5B` |
  | Midnight | `0x6120765Ba5336150BbdDdD0Cd9108B5bFD369632` |

  More are in `research/evidence/lending/onchain_morpho.json`.
- **There are no MetaMorpho V1 vaults on this chain.** Vaults are Vault V2 only.
- Robinhood's own docs list Morpho as the **only lending partner**, and they describe "Deposit NVDA as collateral… borrow USDG" as a use case.

### Data sources

| Need | Source | 4663? | Evidence |
|---|---|---|---|
| Markets, params, state, APYs, USD values, warnings, `listed` flag | **Morpho API** `https://api.morpho.org/graphql` | yes | `chains` includes `{id:4663, network:"Robinhood Chain"}`; 277 markets; `morphoBlues` TVL $574M |
| Vaults (V2) | same API, `vaultV2s` | yes | 38 vaults |
| User positions | API `userByAddress` / `marketPositions`; onchain `position(id,user)` | yes | cross-checked for one borrower: collateral and borrowShares identical |
| Rewards | **Merkl** `https://api.merkl.xyz/v4/opportunities?chainId=4663` | yes | 80 opportunities. The Morpho API's `rewards` field **misses** the Steakhouse and USDe campaigns |
| Ground truth | Morpho contract `idToMarketParams`, `market`, `position`; oracle `price()`; IRM `borrowRateView` | yes | see cross-check below |
| SDK | `@morpho-org/blue-sdk` / `morpho-ts` | yes | ChainId 4663 with addresses and deploy blocks |

**Everything we asked for is retrievable:** markets, collateral asset, loan asset, LLTV, supply APY, borrow APY, utilization, total supply, total borrow, liquidity, vaults, rewards (through Merkl) and user positions.

### Onchain vs API cross-check

| Market | What matched | Block |
|---|---|---|
| USDe/USDG `0xc845…ddd6` | params, `keccak(abi.encode(MarketParams))` = id, totals, oracle price | 71146xxx (`validate:morpho`) |
| SPY/USDG `0x50bc…8e55` | params, id hash, totals, oracle price | 71146xxx |
| syrupUSDG/USDG and NVDA/USDG | borrow APY recomputed from IRM `borrowRateView` agrees to 1e-8 | 71130970 (research) |

- API `supplyApy` = `expm1(ln(1+borrowApy) × utilization × (1−fee))`. The supply rate is compounded, not the naive product. This is implemented in `src/lib/rates.ts` and tested against the live USDe market.

### What is live (API fetch 2026-09-24T05:43Z)
- 277 markets, of which **9 are `listed`**, plus 38 Vault V2 vaults.
- About 99 % of the value sits in 4 listed USDG markets at 91.5 % LLTV, whose collateral is USDe, syrupUSDG, mGLO and spUSDG. They are funded almost entirely by **Steakhouse USDG** `0xBeEff033F34C046626B8D0A041844C5d1A5409dd` ($497.8M, 3.97 % APY).

| Market (collateral/loan) | Supply APY | Borrow APY | Util. | Supply | Oracle |
|---|---|---|---|---|---|
| USDe/USDG | 4.09 % | 4.53 % | 90.4 % | $332.1M | MetaOracle (see risks) |
| syrupUSDG/USDG | 3.66 % | 4.08 % | 89.9 % | $120.6M | ChainlinkOracleV2 (exchange-rate feed) |
| mGLO/USDG | 4.97 % | 5.50 % | 90.6 % | $31.5M | ChainlinkOracleV2 (Midas feed, not in the Chainlink directory) |
| spUSDG/USDG | 2.73 % | 3.03 % | 90.1 % | $13.2M | ChainlinkOracleV2 (ERC-4626 vault) |

### Stock Token markets
- **50 canonical Stock Tokens are collateral in about 150 markets. All of them are unlisted.** Real borrowing against them is tiny: under $5k in total.
- Example: NVDA/USDG `0x6630…4edc` (LLTV 62.5 %, standard ChainlinkOracleV2 = NVDA feed ÷ USDG feed) holds $6.6k supply and $0.4k borrow.
- Several Stock Tokens are also *loan* assets in empty markets.
- **A router can truthfully say "NVDA can be used as collateral on Morpho", but must show that the market is unlisted, small and illiquid.**

## Risks found (objective, recorded in RiskMetadata)

1. **Six oracles double-apply uiMultiplier (CONFLICT with the docs).** The oracles are for NVDA `0xED29D310…Cb78c`, AAPL `0xD625d488…E097`, GOOGL `0x12Ec3474…F424`, SPCX, COIN and MSFT. Each one exposes `uiMultiplier()` and returns price = Chainlink price × uiMultiplier. For NVDA we measured a ratio of **1.0007751591646** against the standard oracle, exactly NVDA's multiplier. Robinhood's docs say the feed already includes the multiplier, so these oracles overvalue collateral by the multiplier: about 0.08 % today, and 4× for a token like CRWD (multiplier 4.0) if one existed. These markets hold about $850k of idle USDG with about $1k borrowed. The router must set `oracle.multiplierHandling = "DOUBLE_APPLIED"` on them.
2. **The $332M USDe market is priced by a MetaOracle** (an EIP-1167 clone of `0x6a16d6fe…a729`):
   - primary oracle: a flat **1.0 USDe = 1.0 USDG**
   - backup: 0.99966
   - switches only on a 0.5 % deviation challenge
   
   This is a fixed-price oracle in practice. Show `oracle.kind = "META_ORACLE"`.
3. **Look-alike tokens:** some markets use a fake "USDG" (`0x8c864e58…6796`) and a fake "WETH" (`0xd0f200ba…a839`). Key everything on addresses.
4. **Deposits into Steakhouse USDG:** the API flags `deposit_disabled` (RED). Merkl labels the campaign "Robinhood Users Only" with `depositUrl` on applink.robinhood.com. The vault gates are all zero, so *why* deposits are disabled is UNVERIFIED. Present it as "protocol reports deposits disabled", not as open to everyone.

## LIKELY
- The `listed` flag and the `not_whitelisted` / `unrecognized_collateral_asset` warnings are Morpho's own curation signals. The router should default to listed markets and require an explicit "show unlisted" toggle.

## UNVERIFIED
- Who deployed the six double-multiplier oracles, and their source code.
- The cause of `deposit_disabled` on Steakhouse USDG.
- Longbow's claim to curate 55 of these markets (DefiLlama only).

## Recommended production source per field

| Field | Primary | Cross-check |
|---|---|---|
| market list / params | Morpho API | `idToMarketParams` |
| totals / utilization / liquidity | Morpho API `state` | `Morpho.market(id)` |
| supply / borrow APY | Morpho API | IRM `borrowRateView` → `rates.ts` |
| oracle price | onchain `price()` | API `state.price` |
| rewards | Merkl API | Morpho API `rewards` (incomplete) |
| listed / warnings | Morpho API only | – |
| positions | Morpho API | `position(id,user)` |
| vault TVL / APY | Morpho API `vaultV2s` | `totalAssets()` |

### Useful GraphQL (all worked 2026-09-24)
```graphql
{ markets(first:200, skip:0, where:{chainId_in:[4663]}) { pageInfo{countTotal} items { marketId listed lltv irmAddress
  loanAsset{address symbol decimals} collateralAsset{address symbol decimals} oracle{address type}
  warnings{type level} state{ blockNumber timestamp price supplyApy borrowApy utilization fee supplyAssets borrowAssets
  liquidityAssets supplyAssetsUsd borrowAssetsUsd liquidityAssetsUsd rewards{asset{address symbol} supplyApr borrowApr} } } } }
{ vaultV2s(first:100, where:{chainId_in:[4663]}) { items { address name listed asset{address symbol} totalAssetsUsd apy netApy
  curator{address} warnings{type level} } } }
{ userByAddress(address:"0x…", chainId:4663) { marketPositions{ market{marketId} healthFactor state{collateral borrowShares borrowAssets} } } }
```

Schema notes:
- `uniqueKey` is gone; use `marketId`. `marketByUniqueKey` is gone; use `marketById(marketId, chainId)`.
- Large `vaultV2s` queries hit the complexity limit, so split them.
