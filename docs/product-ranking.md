# Product ranking (Phase 5)

`src/product/ranking.ts`. Cards are ordered by deterministic, category-specific comparators.

Rules:
- There is no universal score.
- No ordering across top-level categories (TRADE / EARN / BORROW / LIQUIDITY) or across subcategories.
- No card is labelled "best".
- Each card carries its `ranking` factors: comparator name, primary and secondary keys, position, and context (the trade target and input amount).

## Rules shared by every comparator
1. The primary key is always **usability**: ACTIONABLE, then LIMITED, then INFORMATIONAL. A limited item never outranks an actionable one because of a higher number.
2. Missing values (`null`) sort **last**. They are never treated as 0.
3. Rates are compared only when they share type, side (EARN/PAY) and unit. Pendle implied APYs in an accounting unit (`accounting:<key>`) are not compared with token-unit rates. Incomparable pairs fall through to the next key.
4. The last key is always `cardId`, so ties are deterministic.
5. `rankCards` throws `IncompatibleRankingError` when cards from different subcategories are mixed, or when quoted routes differ in input asset, output asset or input amount.

## Comparators
| Comparator | Subcategory | Keys after USABILITY |
|---|---|---|
| TRADE_ROUTE_V1 | TRADE (no amount) | all markets verified → route (bottleneck) liquidity desc → fewer hops → lower combined fee → cardId |
| TRADE_QUOTE_V1 | TRADE (explicit amount) | expected output desc → price impact asc → newer quote block → cardId |
| LEND_V1 | LEND | supply APY desc → available liquidity desc → TVL desc → cardId |
| VAULT_V1 | VAULT | net APY desc → TVL desc → cardId |
| FIXED_YIELD_V1 | FIXED_YIELD | maturity known → implied APY desc (same unit only) → liquidity desc → earlier maturity → cardId |
| YIELD_V1 | YIELD | liquidity desc → earlier maturity → cardId. **Never** by YIELD_EXPOSURE_APY, which is speculative |
| LP_V1 | LP | net APY desc (same unit only) → liquidity desc → cardId |
| COLLATERAL_V1 | COLLATERAL | borrow-asset group (by symbol, then key) → borrow APY asc → borrowable liquidity desc → LLTV desc → cardId |

Notes:
- Trade routes are ranked **within one target**. NVDA→USDG and NVDA→WETH are separate groups (`ranking.context.target`), and positions restart per group.
- Borrowing USDG and borrowing WETH are different intents. COLLATERAL_V1 groups by borrow asset before comparing APYs.
- The PRODUCT-mode per-target cap (`PRODUCT_MAX_ROUTES_PER_TARGET = 5`) is applied **after** ranking. The cut is reported in `moreRoutes`.

## Why these keys
- **LEND/VAULT:** what the depositor earns comes first, then whether the size fits (liquidity/TVL).
- **FIXED_YIELD:** the implied rate is only meaningful with a known maturity and within one unit.
- **YIELD:** YT's "APY" is a leveraged bet on future yield and can be −100 %. Ordering by it would present speculation as return.
- **COLLATERAL:** the cost of borrowing (lower first) within one borrow asset, then whether the market can lend, then LLTV.
- **TRADE:** without an amount, the most liquid verified path; with an amount, what the user actually receives.
