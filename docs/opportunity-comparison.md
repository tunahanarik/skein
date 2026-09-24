# Comparing opportunities

`src/opportunities/comparison.ts` (groups) and `src/opportunities/query.ts` (sorting). There is no subjective scoring: no "best", no "safe", no blended rank.

## Comparison groups

Every yield metric belongs to exactly one group. Metrics are **shown side by side only within a group**, and **ranked only when type, side and unit (`denominatedIn`) all match**.

| Group | Metrics | What it answers |
|---|---|---|
| CAPITAL_YIELD_VARIABLE | SUPPLY_APY, BASE_APY, NET_APY (EARN, non-LP) | floating return on deposited capital |
| CAPITAL_YIELD_TO_MATURITY | IMPLIED_APY, FIXED_APY | rate locked by buying at today's price and holding to maturity |
| BORROW_COST | BORROW_APY, NET_APY (PAY) | cost of borrowing; lower is cheaper |
| LP_RETURN | LP_APR, NET_APY on LP | composite return that moves with pool composition |
| YIELD_SPECULATION | YIELD_EXPOSURE_APY | depends on future realised yield; can be negative |
| INCENTIVE | REWARD_APY | paid in reward tokens; can end at any time |
| REFERENCE | UNDERLYING_APY, COMPONENT_APY | context figures, not returns the user earns by entering |

`compareMetrics(a, b)` returns `{ displayTogether, rankable, caveats[] }`. Caveats name any difference in denomination, basis or group.

Some consequences:
- **Morpho SUPPLY_APY and Pendle IMPLIED_APY** are different groups: variable versus to-maturity. They are listed together for an asset but never ranked against each other.
- **Pendle IMPLIED_APY on NVDA and on USDG** are the same type, but `denominatedIn` differs: NVDA is null (share units) and USDG is USDG. `rankable` is false and the caveat says so.
- **A YT's YIELD_EXPOSURE_APY is not comparable to lending.** Pendle's own figure can be −100 % (see pendle-semantics.md).

## Sorting rules (engine)

- **`YIELD` sort:** one `YieldMetricType` and an explicit direction, e.g. `IMPLIED_APY:DESC`.
  - Opportunities without **exactly one** metric of that type are not ranked. They are appended by id and listed in `notComparable`. **A missing value is never treated as 0.**
- **`MATURITY` sort:** soonest first by default. Open-ended opportunities have no maturity and are `notComparable`.
- **`TVL_USD` / `LIQUIDITY_USD` / `UTILIZATION`:** missing values are not comparable.
  - `availableLiquidity` means different things by `liquidityKind` (BORROWABLE, WITHDRAWABLE_SUPPLY, INSTANT_WITHDRAWAL, POOL_LIQUIDITY). A liquidity sort orders by USD size only; it does not say the figures mean the same thing.
- **Ties** are broken by id, so ordering is deterministic.

## Eligibility vs discovery

Discovery keeps everything an adapter finds. The **default view** shows only opportunities that pass the default eligibility policy (`src/config/eligibility.ts`, id `default-v1`). The engine computes this from canonical fields alone (`src/opportunities/eligibility.ts`), never from `details`.

| Reason | Excludes by default | From |
|---|---|---|
| DATA_CONFLICT | yes | `verificationStatus = CONFLICT` (e.g. Morpho double-multiplier oracles, API/chain identity conflicts) |
| UNVERIFIED_ASSET | yes | `risk.allAssetsCanonical = false` |
| INSUFFICIENT_VERIFICATION | yes | canonical assets but status UNVERIFIED or THIRD_PARTY_ONLY |
| EXPIRED | yes | lifecycle EXPIRED |
| INACTIVE | yes | lifecycle INACTIVE |
| DEPOSIT_DISABLED | yes | blocker (e.g. Morpho vault `deposit_disabled`) |
| PROTOCOL_PAUSED | yes | blocker (e.g. Pendle SY `paused()`) |
| ENTRY_STATE_UNKNOWN | yes | lifecycle UNKNOWN / canEnter null |
| ENTRY_ROUTE_UNKNOWN | yes | `entry.kind = UNKNOWN` |
| UNRESOLVED_YIELD_SEMANTICS | yes (Phase 4, P3-1) | the category's headline metric carries `semantics.status = UNRESOLVED` (e.g. Pendle Stock Token YT) |
| DUST_LIQUIDITY | yes (Phase 4, P3-2) | venue size `max(TVL USD, available liquidity USD)` < $50; unknown USD is never dust |
| PROTOCOL_UNLISTED | no (advisory; P3-3) | `risk.protocolListed = false` |
| LOW_LIQUIDITY | no (advisory; also a warning) | liquidity USD < $10,000 (policy constant) |
| ZERO_LIQUIDITY | no (advisory) | liquidity amount 0 |

- **Nothing is deleted.** Every result reports `excluded: { total, byReason }`.
- **`eligibility: "ALL"`** returns everything discovered (debug).
- **`includeReasons: [...]`** re-admits opportunities whose *only* excluding reasons are listed. For example `["EXPIRED"]` gives `--include-expired`, and `["DATA_CONFLICT"]` gives `--include-conflicted`.
- **A USDG = $1 oracle assumption is not a reason.** It stays a risk fact plus the `ORACLE_ASSUMES_LOAN_PEG` warning (Phase 3 policy decision).

## Phase 4 policy decisions (from Phase 3 open questions)

**P3-1: unresolved yield semantics.** Pendle reports −100 % Long Yield APY (and underlyingApy 0) for Stock Token YTs, while the SY rate is the uiMultiplier, which grows with reinvested dividends. The figure may leave out that growth, and without multiplier history we have no verified replacement.
- The adapter keeps the value as supplied and marks the metric `semantics: { status: "UNRESOLVED", reason }`.
- The engine excludes an opportunity when its *headline* metric (`src/opportunities/headline.ts`) is UNRESOLVED.
- Only the YT is affected, because the headline of PT (onchain implied rate) and of LP is not the flagged metric.
- `includeReasons: ["UNRESOLVED_YIELD_SEMANTICS"]` or `--debug` shows it again.

**P3-2: dust vs low liquidity.** These are two separate reasons.
- `LOW_LIQUIDITY` (< $10k) stays advisory.
- `DUST_LIQUIDITY` (< $50) excludes.
- **Venue size** is the larger of TVL and available liquidity. Both are priced by the Phase 1 Price Service, so an empty borrow side of a market with real collateral is not dust.
- **Threshold research** (live, 2026-09-24, 408 default-view opportunities before this change):

| Venue size | Opportunities |
|---|---|
| < $0.01 | 232 |
| $0.01–1 | 6 |
| $1–10 | 32 |
| $10–100 | 23 |
| $100–250 | 78 |
| ≥ $250 | 37 |

- **Why $50:** curator seed deposits sit at exactly $1, $10, $25 and $100.01, and $50 avoids all of them. It is ~50× the $0.995 Pendle dust market and ~1,000× below the $49.8k USDG market.
- **Effect:** the default view went from 408 to 115 opportunities. Most of the removed ones are empty Morpho markets; nothing is deleted, and `--debug` shows them.
- **Configuration:** `DEFAULT_ELIGIBILITY_POLICY.dustLiquidityUsdE18`.

**P3-3: unlisted markets.** `PROTOCOL_UNLISTED` stays advisory. A market that is discovered from official factory logs, contract-verified, structurally valid, not dust, not paused and not expired stays in the default view (tested).
