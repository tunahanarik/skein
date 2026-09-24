# Stock Tokens

Checked 2026-09-24 (live, `pnpm validate:assets` and `pnpm validate:oracles`, snapshots in `research/snapshots/`) plus the 2026-09-23 research (`robinhood-terminal/docs/research/evidence/B_stock_tokens.md`). Terminology follows the Robinhood brand rules: "Stock Tokens", never "tokenized stocks".

## CONFIRMED

### Canonical registry and identity
- **The canonical list is `GET https://api.robinhood.com/rhj/assets`** ([docs /chain/stock-token-apis](https://docs.robinhood.com/chain/stock-token-apis)). The docs' Token Contracts table ([/chain/contracts](https://docs.robinhood.com/chain/contracts)) is rendered from this URL. That page also says a token with a matching name or ticker at a different address "is not a Robinhood Stock Token".
- Live 2026-09-24: **195 assets, all `ASSET_STATUS_ACTIVE`, all on chain 4663, all 18 decimals.**
- **All 195 cross-checked onchain at block 71142408** in one Multicall3 call (975 reads, 543 ms). For each token, `uid()` = API `id`, `symbol()` = `tokenSymbol`, `decimals()` = 18, `uiMultiplier()` = `currentMultiplier`, and `ACCESS_CONTROLLED_REGISTRY()` = `0xe10b6f6b275de231345c20d14ab812db62151b00`. **0 mismatches.**
- **37** tokens have `uiMultiplier ≠ 1.0` today (36 yesterday: a corporate action was applied in between).
- Architecture:
  - Each token is a 283-byte **beacon proxy**. The beacon (the "registry") is `0xe10b…1b00` and the implementation is `0xb35490d6…c5ae2`. **One registry upgrade changes every token at once.**
  - Factory `0x4783c67b…c046` emits `Deployed(uid, token, name, symbol)`. It has deployed 204 tokens, but only 195 are listed, so **"issuer-deployed" ≠ "canonical"**.
- Identity rule for our app: a Stock Token is canonical **iff** its address is in `/rhj/assets` with status ACTIVE on 4663. Symbols are for display only. Morpho already has look-alike USDG and WETH tokens in its markets.

### Sample dataset (block 71142408)

| Symbol | Address | uid | uiMultiplier | totalSupply (raw/1e18) | totalSupplyUI | Chainlink feed (proxy) |
|---|---|---|---|---|---|---|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | `…915f4774…7ce5` | 1.000775159164630595 | 90,530.80 | 90,600.98 | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` |
| AAPL | `0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9` | `…c2425be3…c649` | 1.000566080061092436 | 16,029.52 | 16,038.60 | `0x6B22A786bAa607d76728168703a39Ea9C99f2cD0` |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` | `…cfece324…2d9f` | 1.0 (never updated, `effectiveAt` = 0) | 12,315.19 | 12,315.19 | `0x4A1166a659A55625345e9515b32adECea5547C38` |
| GOOGL | `0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3` | `…53b69e20…5df3` | 1.000193924414112587 | 18,299.11 | 18,302.66 | `0xF6f373a037c30F0e5010d854385cA89185AE638b` |

For all four: `paused()` = false, `oraclePaused()` = false, and `newUIMultiplier()` = `uiMultiplier()`, so no change is pending.

### Balance semantics (ERC-8056 Scaled UI Amount)
Source: [docs /chain/building-with-stock-tokens](https://docs.robinhood.com/chain/building-with-stock-tokens) and the onchain reads above.
- `balanceOf()` and `totalSupply()` **never change** because of corporate actions. The tokens do not rebase.
- `uiMultiplier()` is fixed-point 1e18. Dividends are reinvested and splits are applied by raising it. For example, a 4:1 split multiplies it by 4.
- **Share-equivalent = `balanceOf × uiMultiplier / 1e18`**, which equals `balanceOfUI(address)`.
- Every transfer emits `Transfer` and `TransferWithScaledUI(from, to, value, uiValue)`, so standard indexers keep working.
- Pending changes are exposed as `newUIMultiplier()` + `effectiveAt()`, and the API exposes them as `pendingMultiplier` + `pendingMultiplierEffectiveTime`.

### Price semantics: two sources, two meanings
| Source | What it prices | Multiplier | Freshness |
|---|---|---|---|
| **Chainlink Stock Token feed** (proxy from the [Chainlink directory](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json)) | **One token.** Docs: "The Chainlink price already includes the corporate-action multiplier… don't apply the multiplier yourself" | included | heartbeat 86,400 s, deviation 0.5 %, 24/5; holds the last price when the market is closed |
| **Robinhood `GET /rhj/prices/{symbol}`** | **One underlying share** (raw bid/ask) | **not** included | 15 s server cache; `"0"` means unavailable; `isTradingHalt` flag |

- Only **33 of 195** tokens have a Chainlink feed today (live directory, 2026-09-24). The docs' claim that "every Stock Token has a live Chainlink price feed" conflicts with this. The count was 35 yesterday; the directory changes.
- The feed-to-token mapping exists **only by ticker in the feed name** ("Robinhood NVDA / USD"). The directory has no token-address field, and `description()` onchain is inconsistent ("RHNVDA / USD" vs "Robinhood AAPL / USD"). So we map by name, then confirm with a price cross-check.

### The calculation ("Wallet X owns Y NVDA Stock Tokens")
Implemented in `src/lib/stockToken.ts`, tested in `test/stockToken.test.ts`, and run live by `pnpm portfolio <address>`:

```
raw        = NVDA.balanceOf(X)                        // integer, 18 decimals — never changes on corporate actions
m          = NVDA.uiMultiplier()                      // 1e18 fixed point, read at the SAME block
tokens     = raw / 1e18                               // "NVDA Stock Tokens held"
shares     = raw × m / 1e18 / 1e18                    // "≈ NVDA shares of exposure" (= balanceOfUI / 1e18)

USD, preferred (feed fresh: now − updatedAt ≤ heartbeat, answer > 0):
  usd = raw / 1e18 × feedAnswer / 1e8                 // feed already contains m → do NOT multiply again
USD, fallback (no feed or stale feed; quote not halted, bid & ask > 0):
  usd = raw / 1e18 × m / 1e18 × (bid + ask) / 2       // REST quote is per underlying share → apply m once
Otherwise: UNPRICED (never guessed)
```

**Worked example, live at block 71142408:** 2 NVDA tokens (raw 2e18), m = 1.000775159164630595, feed = 224.41382169.
- tokens = 2
- shares ≈ 2.001550318
- usd = 2 × 224.41382169 = **$448.83**
- Wrong, double-applying m: $449.18.
- The portfolio probe valued 163 Stock Token holdings in one wallet this way: 394 reads in about 0.9 s, with every row labelled with its price source.

**Can the raw ERC-20 balance be shown directly?** As "tokens held", yes, because it is the transferable amount. It must **not** be labelled as shares when `m ≠ 1`. The UI should show both, with share-equivalents clearly marked as derived.

### Corporate actions, halts and controls
- `GET /rhj/corporate-actions` (1 h cache): 52 entries on 2026-09-23, all `CASH_DIVIDEND`. Splits and other types exist in the enum but none are live yet.
- Corporate actions surface onchain as `UIMultiplierUpdated(old, new, effectiveAt)`. Primary-market orders pause from about 02:00 CET on the effective date until about US market open ([docs rhj/corporate-actions](https://docs.robinhood.com/rhj/corporate-actions)).
- Halts: `/rhj/prices.isTradingHalt`, `paused()` (global), `tokenPaused()`, and `oraclePaused()`. `oraclePaused()` is advisory; the docs say to keep the `updatedAt` staleness check as the primary guard.
- Issuer controls:
  - a registry **blocklist** (175 addresses net blocked on 2026-09-23)
  - global and per-token pause
  - role-gated mint and burn
  - an `adminBurn`-style selector (name resolved from a signature DB, so the exact semantics are UNVERIFIED)
  - There is **no allowlist**.
- Eligibility (legal, not onchain): Stock Tokens "may not be offered, sold, or delivered… in the United States or to… U.S. persons". Other jurisdictions are restricted as well ([rhj/restricted-jurisdictions](https://docs.robinhood.com/rhj/restricted-jurisdictions)).

## LIKELY
- **The feed includes the multiplier. This is what the docs say; our own data supports it only weakly.** No feed-covered token has a multiplier large enough to decide it (the largest is TSM at 1.0015). Among tokens with fresh feeds (updated within 15 minutes) and a multiplier at least 0.05 % off 1.0, most fit "includes" better. In the first run the gaps were:

  | Token | Gap if feed includes m | Gap if feed excludes m |
  |---|---|---|
  | TSM | 0.003 % | 0.15 % |
  | ORCL | 0.04 % | 0.26 % |
  | NVDA | 0.013 % | 0.09 % |

  A later run gave 3 of 4. Status: the docs are authoritative (VERIFIED_OFFICIAL_DOCS); the empirical support is LIKELY, not VERIFIED.
- The 6 Morpho oracles that multiply the Chainlink price by `uiMultiplier` again are therefore overvaluing collateral by m. See [morpho.md](morpho.md).

## UNVERIFIED
- The exact ERC-8056 switch-over behaviour: does `uiMultiplier()` return `newUIMultiplier` automatically once `effectiveAt` passes, or only after an admin transaction? No pending change was live to observe. The code prefers a live `uiMultiplier()` read at the valuation block, and falls back to `effectiveMultiplier()` for cached snapshots.
- The format of `pendingMultiplierEffectiveTime`: we have never seen a non-empty value.
- The verified Solidity source. Blockscout is blocked and no official GitHub repo exists, so the ABI above is taken from docs and bytecode selectors.
- Chainlink L2 sequencer-uptime feed for 4663. The docs recommend one, but none is listed.

## Sources
- https://docs.robinhood.com/chain/stock-tokens, /building-with-stock-tokens, /stock-token-apis, /contracts, /oracles-and-price-feeds (2026-09-23/24)
- https://api.robinhood.com/rhj/assets, /rhj/prices, /rhj/corporate-actions (live 2026-09-24)
- https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json (Last-Modified 2026-09-24 04:22:40 GMT)
- https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood
- RPC `https://rpc.mainnet.chain.robinhood.com`, blocks 71142408–71146499
