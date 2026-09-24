# Coverage matrix (Phase 5)

`AssetIntelligenceService.getCoverage()` and `pnpm coverage [--json]`. It shows, per canonical asset, which intents the integrated protocols (Morpho, Pendle, Uniswap v3) support today. It is computed from the same snapshot as the asset views.

## Row (`CoverageRow`)
| Field | Meaning |
|---|---|
| `asset` | canonical registry asset (key, address, symbol, type) |
| `portfolioPriceUsd`, `priceFreshness` | Phase 1 Price Service (PORTFOLIO_PRICE) |
| `byRawCategory` | raw opportunity count per raw category (TRADE counts market directions) |
| `actionable / limited / informational / hidden / unavailable` | usability of the asset's raw opportunities ([product-usability.md](product-usability.md)) |
| `protocols` | protocols with an ACTIONABLE or LIMITED item |
| `capabilities` | same derivation as the asset view: `canX` only with an ACTIONABLE item; `detail` ACTIONABLE / LIMITED_ONLY / INFORMATIONAL_ONLY / NONE |

The EARN, BORROW and LIQUIDITY capabilities are identical to the asset view's. `pnpm validate:intelligence` checks this for NVDA, USDG and TSLA.

TRADE differs: coverage judges each **market** (pool direction), while the asset view judges **routes** to its default targets. The two can differ when an asset trades only against a non-default counterpart.

## CLI
```
pnpm coverage          # table: Y actionable · L limited only · i informational only · . none
pnpm coverage --json   # { generatedAt, rows: CoverageRow[] }
```

## Live snapshot (2026-09-24, public RPC)
- 197 canonical assets.
- Assets with an **actionable** intent:
  - trade 69
  - earn 4
  - borrow 2
  - liquidity 4
- Broadest assets:

| Asset | Trade | Earn | Borrow | Liquidity | Protocols |
|---|---|---|---|---|---|
| USDG | Y | Y | · | Y | Morpho, Pendle, Uniswap |
| WETH | Y | L | Y | · | Morpho, Uniswap |
| NVDA | Y | Y | L | Y | Morpho, Pendle, Uniswap |
| SGOV | Y | Y | L | Y | Morpho, Pendle, Uniswap |
| SPCX | Y | · | Y | · | Morpho, Uniswap |

- Most Stock Tokens are tradable (Uniswap v3). Their Morpho collateral markets are small, so they appear as LIMITED borrow (LOW_LIQUIDITY). Pendle covers NVDA, PFE and SGOV.
- The sparsest assets (e.g. QNT) have no usable opportunity. Their asset view says NO_USABLE_OPPORTUNITIES explicitly.

Known gaps are listed in [research/dex-ecosystem.md](research/dex-ecosystem.md) and [open-questions.md](open-questions.md):
- Uniswap v4 (deferred, P4-1)
- other DEXes (P4-2)
- Spark, Beefy, Steer, Arcadia (not integrated)
