# Price Service

`packages/pricing/src/priceService.ts`. This is the only place assets are priced. Future protocol adapters must call it; they must not price Stock Tokens themselves, and **Morpho oracle prices are never used for portfolio valuation** (see the Morpho finding below).

**Invariant:** `PriceQuote.priceUsd` is always **USD per one whole token**. For Stock Tokens the multiplier is already inside the price, so every holding is valued as `raw × priceUsd`.

## Source priority

| Asset | 1st | 2nd | else |
|---|---|---|---|
| Stock Token | Chainlink Stock Token feed (token price, multiplier included), if valid and FRESH/AGING | Robinhood `/rhj/prices` mid × uiMultiplier (applied once, here), if the quote is FRESH/AGING, not halted, and a multiplier is known | UNPRICED |
| ETH, WETH | Chainlink ETH/USD | — | UNPRICED |
| USDG | Chainlink USDG/USD | — (**no assumed $1**) | UNPRICED |
| Crypto tokens (cbBTC, USDe) | their own Chainlink `<SYMBOL> / USD` feed, looked up by the exact name in `Asset.usdFeedName` (`CHAINLINK_USD_FEED`). Stablecoins use the USDG freshness rule, others the 24/7 ETH rule | — (no pool price, never another token's feed) | UNPRICED |
| syrupUSDG, spUSDG | rate to USDG (Chainlink exchange-rate feed, or ERC-4626 `convertToAssets`) × Chainlink USDG/USD (`USDG_RATE`) | — (no assumed 1:1, no assumed peg) | UNPRICED |
| UNKNOWN | — | — | UNPRICED |

Feeds come from the official Chainlink directory (cached 1 h). Stock feeds are matched to tokens by the ticker in the feed name; tickers with two feeds are dropped as ambiguous. Robinhood quotes come from one bulk `/rhj/prices` call (cached 15 s) and are matched to tokens **by contract address in the quote's deployments**, not by symbol.

Round validity checks (Chainlink guidance):
- `decimals()` equals the directory's value
- answer > 0
- `updatedAt` > 0
- `answeredInRound ≥ roundId`

An invalid round → `INVALID_FEED_ROUND`, and the fallback is attempted.

## Freshness (`packages/core/src/config/freshness.ts`, the only place thresholds live)

Age is measured from the **source's own timestamp** (Chainlink `updatedAt`, quote `generatedAt`), not our fetch time.

| Rule | FRESH ≤ | AGING ≤ | STALE > | Why |
|---|---|---|---|---|
| CHAINLINK_STOCK_FEED | 1 h | heartbeat (86,400 s) | heartbeat | valid within heartbeat by design (0.5 % deviation trigger); feeds hold price while markets are closed |
| CHAINLINK_ETH_USD | 1 h | heartbeat | heartbeat | 24/7 asset |
| CHAINLINK_USDG_USD | heartbeat | heartbeat + 1 h | heartbeat + 1 h | stable asset rarely moves 0.5 %, so hours-old answers are normal |
| ROBINHOOD_QUOTE | 60 s | 15 min | 15 min | docs: 15 s server cache |
| ASSET_REGISTRY | 15 min | 24 h | 24 h | listings change rarely |

Timestamps more than 60 s in the future → `UNKNOWN`. STALE and UNKNOWN prices are **never** returned as current: the fallback is tried, else UNPRICED. AGING prices are used, with an `AGING_PRICE` warning and lower confidence.

## Conflict detection
When a usable Chainlink price and a usable quote-implied token price both exist, the service records:
- `absoluteDifference` (USD per token)
- `percentageDifference`
- `thresholdPct`

Above **1.0 %** (`STOCK_PRICE_CONFLICT_PCT`; feed deviation is 0.5 % and the observed maximum was 0.41 %) it raises `PRICE_CONFLICT`, including the multiplier in `details` so multiplier mistakes are easy to spot. **Chainlink stays the selected price**, and confidence drops to LOW.

## Confidence

| Confidence | When |
|---|---|
| HIGH | primary source FRESH, and the cross-check agreed (Stock Tokens) or none applies (ETH; USDG within 50 bps of peg) |
| MEDIUM | Chainlink FRESH but no cross-check possible; Chainlink AGING with an agreeing cross-check; fresh quote fallback; USDG off-peg |
| LOW | price conflict; AGING without a cross-check; AGING quote fallback |

## Bid / ask
The full quote is kept in `robinhoodQuote`:
- `bid` and `ask` as strings (underlying share prices)
- `underlyingMid`
- `spreadAbsolute` (ask − bid)
- `spreadBps` = (ask − bid) / mid × 10,000, at 1e-6 bps resolution
- `tokenMid` = mid × multiplier
- `isTradingHalt`
- `generatedAt` and freshness

Indicative valuation uses the mid (Phase 0 policy); bid and ask are preserved for later conservative valuation and execution comparisons.

## USDG
```
priceUsd        = Chainlink USDG/USD answer / 1e8            (proxy 0x61B7e5650328764B076A108EFF5fa7282a1B9aD2)
pegDeviationBps = (priceUsd − 1) × 10,000                     live 2026-09-24: 1.00009 → +0.9 bps
USDG_PEG_DEVIATION warning when |pegDeviationBps| > 50        (= the feed's 0.5 % deviation threshold)
stale / invalid feed → UNPRICED                               (never a silent $1)
```
Not handled in Phase 1, recorded in open-questions: a DEX cross-check, and Paxos `isFrozen(wallet)`.

## Verification status of a price
- **Chainlink:** the answer is read onchain, but the feed address and the feed-to-token mapping come from the official directory, so the status is `VERIFIED_OFFICIAL_DOCS`.
- **Quote fallback:** `VERIFIED_OFFICIAL_API` (weakest of the quote and the multiplier's source).

## Morpho oracle finding (preserved for the Morpho phase)
Six Morpho oracles (NVDA `0xED29D310…Cb78c`, AAPL `0xD625d488…E097`, GOOGL `0x12Ec3474…F424`, SPCX, COIN, MSFT) return the Chainlink token price × uiMultiplier. That applies the multiplier a second time (docs/research/morpho.md). The portfolio never reads Morpho oracles. When the Morpho adapter is built, markets using those oracles must be marked `oracle.multiplierHandling = "DOUBLE_APPLIED"` and must not appear as normal verified opportunities.
