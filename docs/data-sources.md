# Data sources, provenance and verification

## Registry of sources (all checked 2026-09-24)

| id | Type | Endpoint | Covers | Auth | Limits | Verification class |
|---|---|---|---|---|---|---|
| `robinhood-chain-rpc` | ONCHAIN | keyed provider (public `https://rpc.mainnet.chain.robinhood.com` for dev only) | everything onchain | key (prod) | public: batches ≤10, 429s, ~10 min state | VERIFIED_ONCHAIN |
| `robinhood-rhj-api` | OFFICIAL_API | `https://api.robinhood.com/rhj/{assets,prices,corporate-actions}` | Stock Token registry, underlying quotes, corporate actions | none | 60 req/s (doc); no cache headers | VERIFIED_OFFICIAL_API |
| `chainlink-directory` | OFFICIAL_DOCS | `https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json` | feed addresses, decimals, heartbeat, threshold | none | ETag/Last-Modified | VERIFIED_OFFICIAL_DOCS (addresses then read onchain) |
| `chainlink-feed` | ONCHAIN | proxy `latestRoundData()` | token / USDG / ETH prices | – | – | VERIFIED_ONCHAIN |
| `morpho-api` | OFFICIAL_API | `https://api.morpho.org/graphql` | markets, vaults, positions, APY, warnings | none | complexity limit 1M | VERIFIED_OFFICIAL_API |
| `pendle-api` | OFFICIAL_API | `https://api-v2.pendle.finance/core` | markets, implied APY, liquidity | none | – | VERIFIED_OFFICIAL_API |
| `beefy-api` | OFFICIAL_API | `https://api.beefy.finance/{vaults,cow-vaults,apy/breakdown,tvl}` | managed LP vaults | none | – | VERIFIED_OFFICIAL_API |
| `steer-api` | OFFICIAL_API | `https://api.steer.finance/getAprs?chainId=4663&dexName=uniswap` | vault APRs | none | – | VERIFIED_OFFICIAL_API |
| `merkl-api` | OFFICIAL_API | `https://api.merkl.xyz/v4/opportunities?chainId=4663` | reward campaigns | none | – | VERIFIED_OFFICIAL_API |
| `geckoterminal` | THIRD_PARTY_API | `https://api.geckoterminal.com/api/v2/networks/robinhood/...` | pools, volume | none | ~10/min | THIRD_PARTY_ONLY |
| `dexscreener` | THIRD_PARTY_API | `https://api.dexscreener.com/...` | pools, volume, liquidity | none | 300/min; token-pairs capped at 30 | THIRD_PARTY_ONLY |
| `defillama` | THIRD_PARTY_API | `https://api.llama.fi/protocols` | **discovery only** | none | – | never displayed as fact |

## Provenance model (implemented: `packages/core/src/model/provenance.ts`)

```ts
DataSource { type, provider, url?, chainId?, contract?, method?, blockNumber?, observedAt, sourceTimestamp? }
Sourced<T> { value, origin: "SUPPLIED" | "COMPUTED", source, verification, inputs?, formula? }
Metric<T> = Sourced<T> | null        // null = not available, never a fabricated 0
```

This answers the four required questions:

| Question | Field |
|---|---|
| Where did this APY come from? | `source.provider` + `url` + `method` (e.g. `morpho-api` / `markets.items[].state.supplyApy`) |
| Where did this TVL come from? | same. A computed TVL carries `inputs` (amount from onchain, price from Chainlink) and `formula` |
| How old is this value? | `freshness(value, maxAge)` uses `sourceTimestamp` (e.g. Chainlink `updatedAt`, API `generatedAt`) before `observedAt`. Derived values take the **oldest** input's time |
| Calculated by us or supplied? | `origin` |

## Verification states (implemented: `packages/core/src/model/verification.ts`)

| State | Meaning | UI treatment |
|---|---|---|
| `VERIFIED_ONCHAIN` | read from the contract at a known block | shown normally |
| `VERIFIED_OFFICIAL_API` | protocol's or issuer's own API | shown normally, source on hover |
| `VERIFIED_OFFICIAL_DOCS` | official docs or deployment registry, not re-read live | shown normally |
| `THIRD_PARTY_ONLY` | indexer or aggregator only | **badge**: "third-party data" |
| `CONFLICT` | authoritative sources disagree | **badge + both values** |
| `UNVERIFIED` | no adequate evidence | **hidden by default**; visible only with an explicit toggle and a warning |

`weakestStatus()` makes derived values inherit the weakest input, so a TVL computed from an onchain balance and a GeckoTerminal price is THIRD_PARTY_ONLY. **The frontend cannot silently treat unverified data as authoritative:** `requiresDisclosure(status)` is the only switch, and it is true for everything except the three VERIFIED states.

## Freshness budgets (proposal)

| Value | Max age before STALE |
|---|---|
| Chainlink stock feed | heartbeat (86,400 s). A price older than 15 min while the market is open → "delayed" badge |
| Chainlink USDG/ETH | heartbeat (86,400 s) |
| `/rhj/prices` quote | 60 s |
| Morpho / Pendle / Beefy / Steer API state | 10 min |
| Merkl campaigns | 1 h |
| onchain pool state | 60 s |
| Asset registry | 15 min (status transitions downgrade immediately on the next refresh) |
