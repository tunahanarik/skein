# Coverage expansion (after Phase 6)

Five venues were added. Each adapter publishes nothing on an API's word alone: candidates are checked onchain at the pinned block, and anything that fails is logged as `MARKET_UNVERIFIED_ONCHAIN` and left out.

| Venue | Categories | Candidates from | Onchain proof | Rate / TVL |
|---|---|---|---|---|
| Spark Savings (spUSDG) | EARN / VAULT (USDG) | config (spark-address-registry `Robinhood.sol`) | `asset()` must be the canonical USDG with the same decimals; a full deposit cap closes entry | APY = vsr^(seconds per year) − 1, exact ray `rpow`; TVL = `totalAssets()` |
| Beefy CLM | LIQUIDITY / LP | Beefy API `/cow-vaults` (chain `robinhood`) | `CLM.wants()` = the API tokens; `strategy().pool()` is an official Uniswap v3 pool (factory + `getPool` round trip) | APY from `/apy/breakdown` (compounded, after the performance fee); TVL = `CLM.balances()` × Phase 1 prices |
| Steer (v3 vaults) | LIQUIDITY / LP | Steer API `getAprs` | the official VaultRegistry lists the vault as active with the v3 beacon; the pool and tokens verify as above. v4 vaults are skipped | fee APR from the API; TVL = `getTotalAmounts()` |
| Ramses CL | TRADE | factory `PoolCreated` events + factory sweep | same checks as Uniswap v3, keyed by tickSpacing; the fee is dynamic and is read every block | reserves = `balanceOf(pool)`; quotes from Ramses QuoterV2 (tickSpacing-keyed) |
| Uniswap v4 (hookless) | TRADE | computed PoolKey ids (token × hub × standard tiers, `hooks = 0`) | `StateView.getSlot0(id)` initialized; `lpFee` = PoolKey fee | reserves = StateView tick walk within ×/÷ 4 of the price (a lower bound); quotes from V4Quoter |

The managed-LP code shared by Beefy and Steer lives in `packages/protocols/src/shared/managedLp.ts`. One LP opportunity is created per canonical token of the pair. Entry needs both tokens, and the note says so: a zap in the protocol's app is not verified here.

The two v3-style DEXes share one adapter through `V3Dialect` (`packages/protocols/src/uniswap/constants.ts`). The dialect sets:
- the protocol and its label
- the factory and the quoter
- the pool key: fee (Uniswap) or tickSpacing (Ramses)
- the tiers
- a static or dynamic fee

Uniswap v3 is the default dialect, and its behaviour and identity labels are unchanged.

## Decisions this resolves
- **P4-1 (Uniswap v4):** integrated for **hookless pools only**. The pool id is computed with `hooks = 0x0`, so no hook code can run in a swap or a quote. Hooked pools are never discovered or quoted. Pools with a non-standard fee or tickSpacing are not discovered.
- **P4-2 (next DEX):** Ramses CL. Its official docs name the addresses, and every one of them was checked live.
- **P4-5 (24h volume):** shown from GeckoTerminal as third-party data (docs/api.md), never used for ordering.

## v4 reserves: why a lower bound
v4 keeps every pool's tokens in the singleton PoolManager, so no per-pool balance exists. A full replay of `ModifyLiquidity` gives exact principal, but the NVDA/USDG 0.3 % pool alone has more than 10,000 such events, which is too heavy for the public RPC.

The tick walk instead reads:
- `getSlot0` and `getLiquidity`
- the bitmap words within ×/÷ 4 of the price
- `getTickLiquidity` for each initialized tick

It then sums the principal inside that window with an exact TickMath port (`packages/protocols/src/uniswap/v4math.ts`). Liquidity outside the window is not counted. Using the lower bound for eligibility thresholds is conservative.

Live check (2026-09-24), NVDA/USDG 0.3 %: tick walk $984k against $0.99M from a full replay (docs/research/dex.md).

## Live counts (2026-09-24, public RPC)
| Adapter | Result |
|---|---|
| Spark | 1 USDG vault, 3.49 % APY, $13.7M TVL |
| Beefy | every active CLM verified; 80 eligible LP opportunities over 37 assets |
| Steer | 2 v3 vaults (1 eligible); 22 v4 vaults skipped |
| Ramses | 108 verified pools on the first run (the event scan resumes over later runs); 1 NVDA → 222.23 USDG |
| Uniswap v4 | 148 verified hookless pools (SPY/USDG $3.87M, META/USDG $3.80M, NVDA/USDG $984k); 1 NVDA → 221.69 USDG |
