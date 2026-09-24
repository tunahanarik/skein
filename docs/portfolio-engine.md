# Portfolio Engine

`getPortfolio(walletAddress)` (`src/portfolio/engine.ts`) turns a public address into a normalized Robinhood Chain portfolio. It is read-only, needs no key, and never signs anything.

```
wallet ─► parseWalletAddress (checksum, reject zero / malformed)      chainId fixed to 4663
      ─► Asset Registry     canonical assets (core + Robinhood Stock Tokens), cached 5 min
      ─► Balance Reader     ONE block: eth_getBalance + ONE Multicall3 pass (balanceOf ×N, uiMultiplier ×Stock Tokens)
      ─► multiplier choice  onchain uiMultiplier() → live registry value → unavailable
      ─► Price Service      held assets only: Chainlink → Robinhood quote × m → UNPRICED
      ─► normalization      value = raw × USD-per-token; display strings; warnings; provenance
      ─► Portfolio
```

## Output (`src/portfolio/types.ts`)

| Field | Meaning |
|---|---|
| `chainId` | always 4663 |
| `walletAddress` | checksummed |
| `blockNumber`, `blockTimestamp` | the single block every balance and multiplier was read at |
| `assets[]` | one `PortfolioAsset` per held asset (plus zero rows with `includeZeroBalances`) |
| `totals.pricedValueUsd` | sum of **priced** rows only |
| `valuationCoverage` | `COMPLETE` / `PARTIAL` / `UNKNOWN`. `totalValueUsd` is set **only** when COMPLETE |
| `registry` | mode (LIVE/SNAPSHOT), data age, freshness, onchain-verified count |
| `rpc` | health snapshot (requests, failures, 429s, timeouts, retries, latency, latest block) |
| `warnings[]` | typed portfolio-level warnings (`src/model/warnings.ts`) |
| `timingsMs` | registry / balances / prices / normalization / total |
| `provenance[]` | block and registry source |

`PortfolioAsset` has these fields:
- identity (`key` = `4663:<lowercase address>` or `4663:native`)
- `balanceStatus`
- `rawBalance` (exact integer)
- `displayBalance` (exact decimal string)
- `stock` (Stock Tokens only: multiplier, source, display shares, pending change)
- `price` (full `PriceQuote`, see [pricing.md](pricing.md))
- `pricingStatus`, `valueUsd`
- `verificationStatus` (the weakest of the asset and its price)
- `warnings`, `provenance`

## Stock Token accounting (exact, with units)

One function, `calculateStockDisplayBalance(rawTokenBalance, uiMultiplierE18)` in `src/lib/stockToken.ts`, is the only place a multiplier touches a balance. Valuation never touches the multiplier: the Price Service already returns USD per whole **token**.

```
rawTokenBalance         = NVDA.balanceOf(wallet)          token base units, 18 dp          2000000000000000000
uiMultiplierE18         = NVDA.uiMultiplier() @ same block 1e18 fixed point                 1000775159164630595
displayBalance          = raw / 1e18                        "tokens held" (transferable)     2
displayShareBalanceRaw  = raw × m / 1e18  (floor)           share-equivalent base units      2001550318329261190
displayShareBalance     = that / 1e18                       "≈ shares of exposure" (derived) 2.00155031832926119
priceUsd (per TOKEN)    = Chainlink "Robinhood NVDA / USD"  8 dp, multiplier INCLUDED       224.41382169
valueUsd                = raw × priceUsd / 1e18             floored once at 1e-18 USD        448.82764338
```

When NVDA has no usable feed, the Price Service returns `priceUsd = mid(bid, ask) × m` (the underlying quote × the multiplier, applied once). `valueUsd = raw × priceUsd` is unchanged. Applying m a second time would give $449.18, which is wrong; a test pins the right answer.

A split token (m = 4.0, 3 tokens held, underlying mid $25.05, no feed) gives:
- display shares = 12
- priceUsd = 100.20
- value = $300.60

## Balance reading
- **Native ETH:** `eth_getBalance`, a separate asset (`type NATIVE`, key `4663:native`). **WETH** is an ERC-20 row (`WRAPPED_NATIVE`). Both are valued at ETH/USD, because WETH is 1:1 redeemable.
- **ERC-20s:** one ordered Multicall3 `aggregate3` with `allowFailure: true`, chunked by call count (`RPC_MULTICALL_CHUNK_SIZE`, default 400). 197 tokens + 195 multipliers = 392 calls = one request.
- **Per-call failure** (for example a token reverts) → that row is `FAILED` with `BALANCE_READ_FAILED`. **Chunk failure** (429/timeout after retries) → only that chunk's rows fail. The portfolio still returns.
- **Zero balances** are returned by the reader and filtered by the engine (`includeZeroBalances` keeps them).
- **Balances are never cached.**

## Totals and coverage

| Situation | `coverageStatus` | `totalValueUsd` |
|---|---|---|
| every held asset read and priced | COMPLETE | = pricedValueUsd |
| any held asset unpriced, or any balance read failed | PARTIAL | null |
| no balance could be read at all | UNKNOWN | null |

An unpriced asset is never counted as $0. The CLI prints "NOT a total" unless the coverage is COMPLETE.

## Unknown tokens (Phase 1 limitation)
The engine scans the **canonical registry only**. Tokens outside it can't be discovered without an indexer: raw RPC has no "tokens held by address", and a chain-wide Transfer scan is explicitly out of scope. A caller may pass `extraTokens: [address]` (CLI `--token`). Such a token is always:
- `type UNKNOWN`, `canonical false`, `UNVERIFIED`, **UNPRICED**
- labelled with metadata that is sanitized and untrusted
- flagged `LOOKALIKE_TOKEN` when its symbol equals a canonical asset's symbol

A fake "USDG" is caught this way in tests.

## Performance (live, public RPC, 2026-09-24)

| Wallet | Held | Registry (cold, incl. 780-call identity check) | Balances | Prices | Normalize | Total |
|---|---|---|---|---|---|---|
| sample A | 166 (163 Stock Tokens) | 1,543–1,978 ms | 633–665 ms | 651–872 ms | 1 ms | 2.9–3.5 s |
| discovered #1 | 3 | cached (0 ms) | 636 ms | 178 ms | 0 ms | 815 ms |
| discovered #2 | 1 (standard assets only) | cached | 618 ms | 182 ms | 0 ms | 800 ms |
| discovered #3 | 4 | cached | 646 ms | 1,002 ms | 0 ms | 1,649 ms |

Network calls per portfolio: 1 `eth_getBalance`, 1 balance multicall, 1 feed multicall, and at most 1 `/rhj/prices` request (cached for 15 s). There is no per-token request, and the cost grows by calls per multicall, not by round trips.

## Anonymized example
`docs/examples/portfolio.fixture.json` is generated from the offline fixture world (`test/fixtures/world.ts`), so no real wallet appears. It shows:
- a Chainlink-priced Stock Token with cross-check
- a split token priced by fallback
- an unpriced token
- a failed balance read
- PARTIAL coverage

## CLI
```bash
pnpm portfolio --address 0x…                   # readable
pnpm portfolio --address 0x… --json            # machine-readable
pnpm portfolio --address 0x… --include-zero
pnpm portfolio --address 0x… --token 0x…       # inspect an unknown token
```
