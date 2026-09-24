# DEX data: "for asset X, where can it be traded, and how deep?"

Checked 2026-09-24 (blocks 71,129,856–71,140,265). Evidence: `research/evidence/dex/` (pool_table.md, compare.json, quotes.json, v3_pools.json, scripts/). Uniswap addresses and topic0s come from the 2026-09-23 research (`robinhood-terminal/…/C_dex_launchpads_routing.md`); they are verified onchain and sourced from [Uniswap/contracts 4663.json](https://github.com/Uniswap/contracts/blob/main/deployments/json/4663.json).

## CONFIRMED

### Venues
- **Uniswap v2/v3/v4** (Uniswap Labs, chain-specific addresses) is where most of the Stock Token liquidity sits.
- v3 forks with their own factories: Ramses CL, Up v3, Alandale, Sushi v3, PancakeSwap v3 and others (Phase 4 correction: PancakeSwap Infinity is NOT deployed on 4663 per its official chain config; see dex-ecosystem.md). They emit the *same* v3 Swap topic, so pools must be admitted by factory, never by topic0.
- **Lighter:** Robinhood docs [/chain/lighter-domains](https://docs.robinhood.com/chain/lighter-domains/) name contract `0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d`. It is an orderbook with a keyless API (`api.rh.lighter.xyz`) and spot books for NVDA/USDG (id 2054), AAPL (2049) and TSLA (2055). Matching happens **offchain** in Lighter's rollup.
- **Rialto:** a propAMM. Router registry `0x71a120CbBf3Ce7cD910a3c50fF77aFc62735687E`. Token search is keyless; quotes need an API key.
- **Aggregators:** LI.FI routes Stock Tokens keylessly (75 quotes per 2 h). A 10,000 USDG→NVDA quote used the intent-based `lifiIntentsDex` with a 0.25 % fee. 0x, 1inch and the Uniswap Trading API need keys.

### Discovery methods (all live-tested)

| Question | Method | Result |
|---|---|---|
| v3 pools for token T | `V3Factory.getPool(T, base, fee)` for base ∈ {WETH, USDG}, fee ∈ {100, 500, 3000, 10000} | works; 26 combos checked. Forks use `getPool(a, b, int24 tickSpacing)` |
| v4 pools for token T | `eth_getLogs` on PoolManager `Initialize` with **topic2 or topic3 = T** (currency0/1 are indexed) | works. NVDA: 14,884 pools, of which 620 are paired with ETH/WETH/USDG and 69 have live liquidity. Mostly launchpad noise, so filter by counterpart + `StateView.getLiquidity` |
| v4 pool state at scale | Multicall3 `aggregate3` over StateView, 800 subcalls per call | about 1.2 s per call |
| v3 price | `slot0.sqrtPriceX96` → `(sqrtP/2^96)^2 × 10^(dec0−dec1)` | exact |
| v3 TVL | `balanceOf(pool)` of both tokens × price | within 0.06 % of GeckoTerminal/DexScreener |
| v4 TVL | replay `ModifyLiquidity` for the poolId, sum L per range, convert at the current sqrtP | **matches DexScreener exactly**; GeckoTerminal is 12–15 % higher. Valid only for hooks that do not move balances outside the pool |
| Fee tier | v3 `fee()`; v4 `Initialize.fee` (`0x800000` = dynamic; the per-swap fee is in the Swap event) | exact; GT's pool names are wrong for some forks |
| Volume | Swap logs (needs indexing) or GT/DS (third-party) | – |
| Price impact | QuoterV2 / V4Quoter `quoteExactInputSingle` through `eth_call` | works, including on a hooked v4 pool |

### Live sample (2026-09-24, onchain TVL unless noted)

| Token | Pool | Venue | Fee | Pair | TVL |
|---|---|---|---|---|---|
| NVDA | `0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3` | Uniswap v3 | 0.05 % | USDG | $5.69M |
| NVDA | `0x62ab521f71431f78ac374cdbadc6cda3c8916b6c` | Uniswap v3 | 0.05 % | WETH | $1.12M |
| NVDA | poolId `0x3bb34a44…4bf1` | Uniswap v4, no hook | 0.3 % | USDG | $0.99M (replay) |
| AAPL | `0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d` | Uniswap v3 | 0.05 % | USDG | $504k |
| AAPL | poolId `0xc748f467…8fdb` | Uniswap v4, no hook | 0.3 % | USDG | $703k (DS) |
| TSLA | `0xf4acdaeeb7022862a763c9b1b885e11191c889e3` | Uniswap v3 | 0.3 % | USDG | $638k |
| TSLA | poolId `0x8517f807…d32e` | Uniswap v4, no hook | 0.3 % | USDG | $841k (replay) |
| USDG | `0x52e65b17fb6e5ba00ed806f37afcd2daa50271ca` | Uniswap v3 | 0.01 % | WETH | $19.1M |

The full table is in `research/evidence/dex/pool_table.md`.

### Price impact (execution data, block 71,136,554)

| Route | Size | Cost vs mid incl. fee |
|---|---|---|
| v3 USDG→NVDA 0.05 % | $1k / $10k / $100k | 0.051 % / 0.056 % / 0.107 % |
| v4 USDG→NVDA 0.3 % (no hook) | $1k / $10k / $100k | 0.36 % / 0.48 % / 1.64 % |
| v3 WETH→NVDA 0.05 % | 1 / 10 / 50 WETH | 0.07 % / 0.26 % / 0.89 % |

## DISCOVERY vs EXECUTION data

| DISCOVERY (Phase 1, read-only) | EXECUTION (later phases) |
|---|---|
| pool list per token (factory `getPool`, v4 `Initialize` logs) | quotes (QuoterV2, V4Quoter, MixedRouteQuoterV2) |
| pair, fee tier, hook address | route search across venues / aggregators |
| mid price (`slot0`, `getSlot0`) | calldata (Universal Router set, SwapRouter02, aggregator APIs) |
| TVL (balances / ModifyLiquidity replay) | slippage limits, deadlines, Permit2 |
| 24h volume, trade count (GT/DS, THIRD_PARTY) | simulation (`eth_call` at latest; Tenderly lists 4663) |
| approximate impact at fixed probe sizes (quoter, read-only) | — |

A read-only quote at fixed probe sizes ($1k / $10k) is useful *discovery* data ("how deep is this venue?") and is allowed in Phase 1. It never produces calldata.

## LIKELY
- Official Uniswap subgraph configs for `robinhood-mainnet` exist in `Uniswap/v2-subgraph`, `v3-subgraph` and `v4-subgraph`. No public endpoint is documented, and The Graph's registry lists no subgraph indexers for 4663. The Goldsky blog says Uniswap pulls Robinhood data through Goldsky.

## UNVERIFIED
- Why GeckoTerminal's v4 reserves exceed the principal replay (uncollected fees?).
- TVL of hooks with custom accounting (for example USDG/ETH pools with lpFee=1 and huge L).
- Units of `fee()` on Up v3 pools (returns 112 for a pool GT names "0.3 %").

## Third-party rate limits (for fallback use)
- GeckoTerminal keyless: about 10 calls/min (a 429 came after 6 calls in 27 s).
- DexScreener: 300 req/min, but `token-pairs` is **capped at 30 pairs** (the top USDG pool was missing).
- LI.FI keyless quotes: 75 per 2 h per IP.
