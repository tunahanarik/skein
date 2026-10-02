# Uniswap adapter (Phase 4)

`packages/protocols/src/uniswap/`. This is the first production TRADE adapter. It is read-only: no swaps, approvals, signatures, permits, calldata or transaction submission. It implements `OpportunityAdapter`, and the engine and router gained no Uniswap-specific code.

| File | Role |
|---|---|
| `constants.ts` | Addresses from the official registry (below), each re-verified live; read-only ABIs |
| `onchain.ts` | discovery (factory getPool sweep, resumable topic-filtered event scan, incremental scan), identity checks, pool state, QuoterV2 calls |
| `poolStore.ts` | persistence of discovered pools, scan progress and immutable identity checks (`.cache/`, not committed; zod-validated on load) |
| `math.ts` | exact bigint prices from `sqrtPriceX96`, price impact on rationals, nominal hop fee |
| `normalize.ts` | pure: pool → one `TradeMarket` + two DIRECT TRADE opportunities |
| `adapter.ts` | caches, tiered state reads, per-pool isolation, indicative quotes |

**Capabilities:**

| Capability | Value | Note |
|---|---|---|
| `discovery` | true | |
| `assetFiltering` | false | the engine filters |
| `userPositions` | false | LP positions are out of Phase 4 scope |
| `singleOpportunity` | true | |
| `quotes` | true | read-only |
| `execution` | false | |

## Deployment research (2026-09-24, from scratch)

**Official source:** [Uniswap/contracts deployments/json/4663.json](https://github.com/Uniswap/contracts/blob/main/deployments/json/4663.json) (`latest`). `pnpm validate:uniswap` compares every address we use with this file, and live code was checked for each.

| Contract | Address | Phase 4 use |
|---|---|---|
| UniswapV3Factory | `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA` | **read**: PoolCreated events, getPool, feeAmountTickSpacing |
| QuoterV2 | `0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7` | **read**: quoteExactInputSingle via eth_call |
| UniswapV2Factory | `0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f` | recorded only (57,420 pairs) |
| UniswapV2Router02 | `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` | recorded only |
| NonfungiblePositionManager (v3) | `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3` | recorded only |
| SwapRouter02 | `0xCaf681a66D020601342297493863E78C959E5cb2` | recorded only |
| TickLens | `0x7DfD4F31be6814D2906BDE155c3e1B146EAc1468` | recorded only |
| PoolManager (v4) | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | recorded only |
| StateView (v4) | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | recorded only |
| V4Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` | recorded only |
| PositionManager (v4) | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | recorded only |
| UniversalRouter v2.1.2 | `0x204FAca1764B154221e35c0d20aBb3c525710498` | recorded only (execution; future phase) |
| MixedRouteQuoterV2 | `0x7edd862aa08dD5Be664C21188E1A2A0E64e3A283` | recorded only |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | recorded only (never used; no permits) |
| UniswapInterfaceMulticall | `0x282A3C4D320Cc7f0d5eaf56B8029e4B88338f0a3` | recorded only (Multicall3 `0xcA11…CA11` is used) |

- **v3 fee semantics:** tiers are measured live with `feeAmountTickSpacing`. 100 / 500 / 3000 / 10000 ppm are enabled, with tick spacings 1 / 10 / 60 / 200; 200 and 2500 ppm are not enabled. The fee is charged on the input of each swap step. The factory owner can enable tiers and set a protocol fee share, but cannot change an existing pool.
- **Pool types:** v2 constant-product pairs, v3 concentrated-liquidity pools, and v4 singleton pools (optionally hooked).

### Why only v3 is integrated in Phase 4

| Version | Live measurement (2026-09-24) | Decision |
|---|---|---|
| **v3** | 2,412 pools involve a canonical non-hub token or two hubs; 463 of them are both-canonical. The deepest are WETH/USDG 0.01 % ($18.9M TVL) and NVDA/USDG 0.05 % ($5.6M). | **integrated** |
| v2 | 57,420 pairs overall. Only 20 pair a Stock Token or WETH with USDG/WETH, or USDG with WETH. The only meaningful one is USDG/WETH (≈ $458k on the USDG side); SPY/USDG ≈ $5k on the USDG side; the rest are dust | deferred: little liquidity. The constant-product math is simple to add later |
| v4 | NVDA alone: 14,896 `Initialize` events; 681 with a canonical counterpart; **521 of those hooked** (Fables etc.); 160 hook-less, of which 48 have active liquidity. AAPL: 175 / 81 hooked / 31 live; TSLA: 142 / 65 / 33. The v4 PoolManager emitted more swaps than v3 in a 34-minute sample (dex-ecosystem.md) | deferred. Hooks run arbitrary code, including inside a quote simulation, so they need a hook allowlist policy. Singleton TVL needs ModifyLiquidity replay. Large Initialize volume. This is a separate integration with its own policy |

This is a real limitation. Some Stock Token liquidity (for example NVDA/USDG v4 ≈ $1M, TSLA v4) and much of the swap flow is on v4 and is **not** shown in Phase 4.

## Discovery (no hardcoded pools)

Measured on the public RPC:
- **429 limit:** a 429 comes after a burst of about 6 log queries; the sustained rate is about 1 query/s.
- **Topic OR-sets:** sets of 10 addresses usually answer in about 0.35 s, but some time out ("log query timed out"). Sets of 50+ time out.
- **Wide ranges:** an unfiltered PoolCreated scan over 71M blocks exceeds 10,000 logs and needs deep bisection.
- **viem batching:** a heavy `eth_getLogs` inside a JSON-RPC batch crashes viem's batch parser. Log queries therefore use an unbatched client.

Design:
1. **Event index (authoritative, resumable).**
   - **Tasks:** the non-hub canonical tokens (Stock Tokens, …) in slices of 10, as `token0 ∈ slice` and `token1 ∈ slice`, plus `hubs × hubs`. Each task is one full-range query.
   - **Timeout handling:** a timed-out slice is **split by tokens**, not by block range. Halving the range re-scans the same OR-set. A single-token task falls back to range bisection, for example for a token with more than 10,000 pools.
   - **Progress:** it is persisted after every task. Each adapter run advances it within `DISCOVERY_SCAN_BUDGET_MS` (30 s), and `pnpm uniswap:index` finishes it in one go (≈ 3–4 min on the public RPC, once).
   - **After completion:** incremental unfiltered scans of new blocks only, every `POOL_LIST` (10 min).
2. **Factory getPool sweep (while the index is incomplete).**
   - `getPool(token, hub, fee)` over every non-hub canonical token × {USDG, WETH} × 4 tiers, plus hub × hub, in about 4 multicalls.
   - The pools that matter for default TRADE results are therefore known from the first run.
   - While the index is incomplete, the adapter is PARTIAL with `MARKET_DISCOVERY_DEGRADED`, which names what may be missing (token × token pools).
3. **Scope.** A pool is indexed when at least one token is a non-hub canonical token, or both are hubs. USDG alone is paired in about 6,000 v3 pools, almost all launchpad tokens. Those hub × arbitrary-token pools are not indexed: they could never pass default TRADE eligibility.

**Pool verification.** Every pool must pass all of these:

| Check | Evidence |
|---|---|
| contract exists and factory origin | `pool.factory() == v3 factory`, and `factory.getPool(token0, token1, fee) == pool` |
| token identity | `pool.token0/token1()` == discovered |
| fee | `pool.fee()` == discovered |
| ordering | `token0 < token1` |
| parameters | `tickSpacing` == the tier's spacing |

The checks are immutable facts: they are persisted and re-verified after `POOL_IDENTITY` (24 h). Symbols are display-only (`sanitizeSymbol`).

## State, price, liquidity

**Primary pools** (both tokens canonical) are read at **every** block:
- `slot0`, `liquidity()`, and both `balanceOf(pool)`

**Secondary pools** (one non-registry token): the state is reused for up to `POOL_STATE_SECONDARY` (5 min). Each value carries its own block number. These pools are never in the default view, never a routing edge and never quoted.

What each state gives:
- **Price:** `DEX_MARKET_PRICE` is exact from `sqrtPriceX96`. The inverse is published separately. It is never used for valuation.
- **Divergence:** if it differs from the Phase 1 portfolio-implied ratio by more than 2 %, the market gets `MARKET_PRICE_DIVERGENCE`. None was seen in the live validation.
- **Liquidity:**
  - TVL (Σ balances × Phase 1 price; null if a side is unpriced)
  - reserves
  - active in-range liquidity L
  - `RESERVES_INCLUDE_UNCOLLECTED_FEES`: TVL is not executable depth
- **States:** ACTIVE, NO_ACTIVE_LIQUIDITY (1,007 of 2,412 live pools), UNINITIALIZED, UNREADABLE.

## Indicative quotes

`QuoterV2.quoteExactInputSingle` is called through eth_call, hop by hop, at the snapshot block. It is refused unless every market is factory-verified, VERIFIED_ONCHAIN, ACTIVE and has two canonical tokens, so no untrusted token code is simulated. See [../trade-routing.md](../trade-routing.md) for the semantics: expected output, effective price, per-hop fee, fee-excluded price impact against same-block spot, `INDICATIVE_QUOTE`, and no minimum output.

**Live check:** 1 NVDA → 223.067215 USDG. An independent `eth_call` gave the identical value. Price impact was 0.0001 % at 1 NVDA and 0.13 % at 1,000 NVDA.

## Performance (public RPC, 2026-09-24)

| Step | Time |
|---|---|
| cold pool-event index (once; `pnpm uniswap:index` or across runs) | ≈ 3–4 min total. The first run shows sweep results after ≈ 40 s (30 s budget) |
| new process, index cached | ≈ 10 s: state for 2,412 pools ≈ 7.5 s (all tiers read once), identity 0 ms (persisted) |
| same process, next block | ≈ 2.3–3.4 s: primary state only, plus prices |
| route graph build | 2 ms (188 edges) |
| route lookup NVDA→USDG | 2 ms on the graph; ≈ 2.3 s including the market snapshot |
| quote, 1 hop / 2 hops | ≈ 0.3–0.6 s per hop over the public RPC (validation: 2.2 s end-to-end incl. snapshot) |
| three-protocol NVDA view (warm) | ≈ 2.2 s |

**Bottleneck:** the public RPC's log limits for the one-time index, and per-process state reads for about 1,950 secondary pools. A keyed provider (open question #1) removes most of it.
