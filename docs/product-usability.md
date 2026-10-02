# Product usability (Phase 5)

`packages/product/src/usability.ts`. Usability answers *"can the user act on this now, and with what limitation?"*. Verification answers a different question, *"how well is this data evidenced?"*, so the two are kept apart. A VERIFIED_ONCHAIN market can still be LIMITED, for example when it is thin.

Usability uses objective inputs only:
- the engine's eligibility result (Phases 3–4)
- liquidity
- data freshness
- for an explicit trade amount, the indicative quote

There is no subjective score.

## Statuses
| Status | Meaning | Default view |
|---|---|---|
| ACTIONABLE | can be done now; no objective limitation found | shown |
| LIMITED | can be done, with an objective limitation (listed in `reasons`) | shown |
| INFORMATIONAL | shown for context; its main purpose cannot be fulfilled now | shown |
| HIDDEN_BY_DEFAULT | an evidence problem | DEBUG only |
| UNAVAILABLE | cannot be entered now (lifecycle) | DEBUG only |

Precedence, first match wins: HIDDEN_BY_DEFAULT, then UNAVAILABLE, then INFORMATIONAL, then LIMITED, then ACTIONABLE. Every reason that applies is listed, not only the one that decided the status.

## Reasons
| Reason | Status | Source / threshold |
|---|---|---|
| DATA_CONFLICT | HIDDEN | engine eligibility (e.g. double-applied oracle multiplier) |
| NON_CANONICAL_ASSET | HIDDEN | eligibility UNVERIFIED_ASSET, or a route through a non-canonical asset |
| INSUFFICIENT_VERIFICATION | HIDDEN | eligibility; or a route with an unverified market |
| DUST_LIQUIDITY | HIDDEN | eligibility, liquidity < **$50** (`dustLiquidityUsdE18`, P3-2; not raised in Phase 5) |
| UNRESOLVED_YIELD_SEMANTICS | HIDDEN | eligibility, Stock Token YT (P3-1); fail-closed, see below |
| LIQUIDITY_UNVERIFIED | HIDDEN | eligibility (TRADE without a priced TVL); or a route whose bottleneck TVL is unknown |
| ENTRY_ROUTE_UNKNOWN, ENTRY_STATE_UNKNOWN | HIDDEN | eligibility |
| EXTREME_PRICE_IMPACT | HIDDEN | quote impact ≥ **15 %** |
| EXPIRED, INACTIVE, DEPOSIT_DISABLED, PROTOCOL_PAUSED | UNAVAILABLE | eligibility lifecycle |
| ZERO_BORROWABLE_LIQUIDITY | INFORMATIONAL | COLLATERAL market whose borrowable liquidity is exactly 0 |
| LOW_LIQUIDITY | LIMITED | non-trade liquidity < **$10,000** (`lowLiquidityUsdE18`, the Phase 3 advisory line) |
| ZERO_LIQUIDITY | LIMITED | engine advisory |
| LOW_ROUTE_LIQUIDITY | LIMITED | TRADE market or route bottleneck TVL < **$10,000** (`minActionableRouteTvlUsdE18`), with or without an amount |
| ELEVATED_PRICE_IMPACT | LIMITED | quote impact **1 % ≤ x < 5 %** |
| HIGH_PRICE_IMPACT | LIMITED | quote impact **5 % ≤ x < 15 %** |
| PRICE_IMPACT_UNKNOWN | LIMITED | impact not computable, or the quote failed |
| STALE_DATA | LIMITED | headline metric freshness STALE or UNKNOWN (`packages/core/src/config/freshness.ts`) |
| QUOTE_STALE | LIMITED | quote block older than **60 s** (`maxQuoteAgeSeconds`, ONCHAIN_STATE FRESH bound) |

## Notes (facts that do not limit usability)
`notes[]` carries neutral facts derived from adapter warnings:
- PROTOCOL_UNLISTED
- ORACLE_ASSUMES_LOAN_PEG
- ACCOUNTING_UNIT_NOT_TOKEN
- IMPLIED_RATE_NOT_GUARANTEED
- UNDERLYING_UNVERIFIED
- YIELD_TOKEN_DECAYS_TO_ZERO
- RESERVES_INCLUDE_UNCOLLECTED_FEES
- MARKET_PRICE_DIVERGENCE
- REWARDS_MAY_BE_INCOMPLETE
- VOLUME_UNKNOWN: every TRADE card, because 24h volume is not measured (P4-5)

## Trade quality (P4-4): discoverable vs actionable
Two thresholds apply to trade, and they answer different questions:
- **Discoverable** (routing edge): verified, canonical, TVL ≥ **$50** (`ROUTING_POLICY.minEdgeTvlUsdE18` = the dust line). Phase 5 does not change it. A thin pool still exists and stays visible in RAW and DEBUG.
- **User-actionable** (`TRADE_QUALITY_POLICY`, `packages/core/src/config/tradeQuality.ts`):
  - without an amount, bottleneck TVL < $10,000 → LIMITED (LOW_ROUTE_LIQUIDITY)
  - with an amount, the quote's price-impact class is added to that

Price-impact classes (fees excluded) follow the Uniswap web interface's own warning levels. The official source is `apps/web/src/constants/misc.ts`, read on 2026-09-24: `ALLOWED_PRICE_IMPACT_LOW` 1 %, `…_HIGH` 5 %, `BLOCKED_PRICE_IMPACT_NON_EXPERT` 15 %.

| Class | Impact | Usability |
|---|---|---|
| LOW | < 1 % | ACTIONABLE (unless the route is thin) |
| ELEVATED | 1 % – < 5 % | LIMITED |
| HIGH | 5 % – < 15 % | LIMITED |
| EXTREME | ≥ 15 % | HIDDEN_BY_DEFAULT (the level at which the Uniswap interface blocks non-expert users) |
| UNKNOWN | not computable | LIMITED |

The observed ~$83 NVDA/USDG pool therefore:
- is LIMITED (LOW_ROUTE_LIQUIDITY) without an amount
- stays LIMITED at any amount whose impact is low
- is hidden at 1 NVDA (≈ 60 % impact, EXTREME)

It never appears as a normal ACTIONABLE route. A unit test pins this case.

## Fail-closed Stock Token YT semantics (Phase 5 fix)
The live smoke run found a fail-open path. When the NVDA `uiMultiplier` read failed (rate-limited), `syRateEqualsMultiplier` was `null`, P3-1 did not fire, and YT-NVDA showed as ACTIONABLE with the API's −100 %. Now a Stock Token YT with a LIQUIDITY accounting unit and an API underlying APY of 0 is UNRESOLVED unless a mismatch was **measured** (`syRateEqualsMultiplier === false`). An unknown value no longer clears it. The fix is in `packages/protocols/src/pendle/normalize.ts`, with a test that makes the multiplier revert.

## Capabilities
Capabilities are derived from cards, never set by hand. `canX` is true only with an ACTIONABLE card for that intent. `detail[intent]` distinguishes LIMITED_ONLY from INFORMATIONAL_ONLY, so a collateral market with nothing to borrow is not a borrow capability.
