# Indexing and data-provider strategy

Checked 2026-09-24. There is no single source that does everything well, so the design is hybrid. For each data type the table below names the source that is **authoritative** (the value we trust) and the one that is **fast** (the value we show first).

## Provider support for 4663

| Provider | 4663 support | Keyless? | Evidence |
|---|---|---|---|
| Public RPC | yes; non-archive, `getLogs` capped at 10k results, 429s | yes | live |
| Alchemy (node, Token API, Transfers API) | yes | no | [Alchemy Robinhood overview](https://www.alchemy.com/docs/robinhood-chain/robinhood-chain-api-overview) + official list in docs /chain/connecting |
| Alchemy Portfolio API | UNVERIFIED | no | chain list not in the docs |
| QuickNode | yes, "full archive" | no | quicknode.com/docs/robinhood |
| Goldsky (Subgraphs, Turbo, Edge RPC) | yes (`robinhood-mainnet`) | no | [docs.goldsky.com/chains/robinhood-chain](https://docs.goldsky.com/chains/robinhood-chain) |
| Envio HyperSync / HyperIndex | yes | no (token) | docs.envio.dev supported networks |
| Dune | yes (`robinhood` schema) | no (API key) | docs.dune.com/data-catalog/evm/robinhood |
| The Graph | Substreams/Firehose only, no subgraph indexers | – | networks-registry |
| Morpho API / Pendle API / Beefy API / Merkl API | yes | yes | live |
| GeckoTerminal / DexScreener | yes (`robinhood`) | yes (about 10/min and 300/min) | live |
| Blockscout mainnet API | Cloudflare-blocked for scripts; PRO API needs a key | no | 2026-09-23 |

## Authoritative source per data type

| Data | Authoritative | Fast / primary path | Notes |
|---|---|---|---|
| Canonical asset list | Robinhood `/rhj/assets` + onchain identity check | cached snapshot, refreshed ≤ every few minutes | never symbol-matched |
| **Wallet balances (known assets)** | **RPC via Multicall3** at a pinned block | same: one `aggregate3` covers 195 Stock Tokens + WETH + USDG + ETH in about 0.4–0.9 s | no indexer needed for the MVP |
| Wallet balances (unknown tokens) | Transfer logs (indexer) or Alchemy Token API | Alchemy `alchemy_getTokenBalances` | Phase 2; only needed to show tokens outside the registry |
| uiMultiplier | onchain `uiMultiplier()` at the same block | API `currentMultiplier` as cache | API and onchain matched 195/195 |
| Stock Token prices | Chainlink feed (token price) | `/rhj/prices` × multiplier for tokens without a feed | 33/195 feeds |
| USDG / ETH price | Chainlink | DEX cross-check | see usdg.md |
| Morpho markets / vaults / APY | Morpho API (protocol-supplied) | same, cached about 60 s | spot-check onchain |
| Morpho user positions | Morpho API `userByAddress` | onchain `position()` for the markets shown | |
| Pendle markets | Pendle API + onchain `readTokens`/`expiry` | API | |
| Spark savings rate | onchain `vsr` / `totalAssets` | same | no API |
| Beefy / Steer vaults | protocol API | API; onchain `balances()` / `getTotalAmounts()` for TVL | Steer subgraph v4 amounts are wrong |
| Rewards | Merkl API | same | eligibility text passed through |
| DEX pools (v2/v3) | onchain factory `getPool` | cached pool registry | |
| DEX pools (v4) | PoolManager `Initialize` logs | our own indexed pool registry (Phase 1 backfill, then incremental) | logs from genesis are available on the public RPC with chunking |
| Pool TVL / price | onchain (`slot0`, balances, ModifyLiquidity replay) | GT/DS as THIRD_PARTY fallback | |
| Volume, trade counts, history | our indexer (Swap logs) **or** GT/DS | GT/DS for the MVP, labelled THIRD_PARTY_ONLY | a Swap indexer is Phase 2 |
| Historical APY / TVL | protocol APIs where offered (Pendle historical, Morpho) | – | our own snapshots from Phase 1 onward |
| Events (multiplier updates, new markets) | logs | polling | no WebSocket on the public RPC |

## Recommendation

1. **Phase 1 needs no custom indexer.** Portfolio = Multicall3 over the registry. Opportunities = protocol APIs (Morpho, Pendle, Beefy, Steer, Merkl) plus onchain reads (Spark, Uniswap v3 `getPool`, v4 state for a curated pool list).
2. **One small log job:** a v4 pool registry built from `Initialize` logs, filtered to counterparts {ETH, WETH, USDG} and to canonical Stock Tokens. This is the only thing that needs `eth_getLogs` at scale. Its output is a table (poolId, currency0, currency1, fee, tickSpacing, hooks, first block).
3. **A keyed RPC is mandatory** (Alchemy or QuickNode per the official list). The public RPC is "not for production".
4. **Goldsky / Envio later**, for swap volume, historical TVL and our own APY history, once we need numbers the protocols don't supply.
5. **Snapshot everything we show** (value + source + block + fetch time) into PostgreSQL from day one. Otherwise there is no history for "how old is this / where did it come from", and no data to build a later risk model.
