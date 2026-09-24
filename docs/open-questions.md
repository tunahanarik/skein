# Open questions

Each item names what would resolve it.

## Added in Phase 4 (decide before Phase 5)
*All seven P4 items were decided at the start of Phase 5:*
- **P4-1:** v4 deferred; needs a hook security policy.
- **P4-2:** no second DEX.
- **P4-3:** Lighter and Rialto are metadata only (`src/config/ecosystem.ts`).
- **P4-4:** a separate user-facing trade-quality policy (`src/config/tradeQuality.ts`); see docs/product-usability.md.
- **P4-5:** volume stays UNKNOWN (`TradeMarket.volume24h`).
- **P4-6:** production requires `ROBINHOOD_RPC_URL`, with an optional `ROBINHOOD_INDEX_RPC_URL`.
- **P4-7:** no aggregator cross-check; that is future execution validation.

P4-1. **Uniswap v4.** A large part of Stock Token liquidity and swap flow is on v4 (e.g. NVDA/USDG v4 ≈ $1M; most NVDA v4 pools are hooked). Integrating it needs three things:
- a hook policy: an allowlist; hooked pools run arbitrary code even in quote simulations
- singleton TVL (ModifyLiquidity replay or StateView tick walk)
- a way to handle about 15k `Initialize` events per popular token

Which hooks, if any, are acceptable?

P4-2. **Next non-Uniswap venue.**
- Ramses CL has official docs, a QuoterV2 and a USDG/NVDA pool of ≈ 88k USDG + 574 NVDA.
- Ekubo/STONX has a keyless quoter API, but it refuses equities for restricted jurisdictions by caller IP.
- Which comes next, and does a jurisdiction-gated API fit the product?

P4-3. **Offchain / keyed venues.** Lighter (offchain orderbook, 26 Stock Token books) and Rialto (quotes need a wallet-signed API key onboarding) cannot be integrated read-only today. Should they be listed as "also tradable on …" without depth?

P4-4. **Dust vs routing.** A $83 pool (above the $50 dust line) produces a DIRECT route whose 1-unit quote has about 60 % price impact. Should routing edges use a higher minimum than DUST_LIQUIDITY, or an amount-aware filter once quotes are requested?

P4-5. **24h volume.** Not reported: it needs Swap-log indexing (about 21k v3 swaps in 34 minutes observed) or a third-party source. Which one?

P4-6. **Keyed RPC (restates #1).** The one-time pool-event index takes about 3–4 minutes on the public RPC because of rate limits and log timeouts, and per-process state reads take about 7 s. A keyed provider is needed for production anyway.

P4-7. **Aggregator benchmark.** KyberSwap, the Sushi API and LI.FI give keyless quotes on 4663. Should one be used only as a read-only cross-check of our indicative quotes (never for execution)?

## Added in Phase 3 (decide before Phase 4)
*P3-1, P3-2 and P3-3 were decided at the start of Phase 4; see opportunity-comparison.md "Phase 4 policy decisions".*

P3-1. **Stock Token YT / underlying APY.** *Decided:* hidden by default (UNRESOLVED_YIELD_SEMANTICS), value untouched. Still open: computing a verified figure from multiplier history.
- The Pendle API reports `underlyingApy` 0 and Long Yield APY −100 % for NVDA, PFE and SGOV.
- Onchain, the SY rate equals the uiMultiplier, which grows with reinvested dividends.
- The API values are shown as supplied, with `UNDERLYING_YIELD_SOURCE_UNCLEAR`.
- To compute our own figure we need multiplier history: either an archive RPC (open question #1) or recording `UIMultiplierUpdated` events.
- Should Stock Token YT opportunities stay in the default view meanwhile?

P3-2. *Decided:* DUST_LIQUIDITY < $50 excludes; LOW_LIQUIDITY stays advisory. Original question: **Dust / onchain-only markets.** A USDG market with about $1 of liquidity (404 in the Pendle API) passes every objective rule and appears in the default view with LOW_LIQUIDITY and PROTOCOL_UNLISTED advisories. Should LOW_LIQUIDITY (or "no protocol-supplied data") become an excluding reason?

P3-3. *Decided:* advisory only. Original question: **PROTOCOL_UNLISTED.** This is advisory by default. The live USDG market with $49.8k liquidity (the only substantial Pendle USDG market) is not whitelisted in the Pendle app. Keep it advisory?

P3-4. **USDG external reward (3.3 %)** is reported by the Pendle API as `EXTERNAL_REWARD`. We cannot verify it onchain (`UNDERLYING_UNVERIFIED`). Who pays it, and is it paid to PT, YT or LP holders? Resolve with the Pendle/Paxos docs.

P3-5. **Router route verification.** `singleTransactionAvailable` cites the deployment file and docs; nothing is simulated (read-only). Should a later phase add read-only `eth_call` quotes (RouterStatic or a Router simulation) so we can show expected output after fees?

P3-6. **API N+1.** We send one Pendle API request per non-expired market (7 today, 4 in parallel). If the market count grows a lot, consider `/v2/markets/all` plus per-market detail only for markets missing `dataUpdatedAt`.

P3-7. **vePENDLE boost.** `maxBoostedApy` is ignored and LP NET_APY is unboosted. Should boosted figures be shown separately?

## Added in Phase 2 (decide before Phase 3)
P2-1. **Default curation.** *Decided in Phase 3:* non-canonical/unverified opportunities are excluded by default. `protocolListedOnly` stays an opt-in filter; unlisted is an advisory.

P2-2. **Double-applied oracles.** *Decided in Phase 3:* excluded from the default view (DATA_CONFLICT) and available with `includeReasons: ["DATA_CONFLICT"]` / `--include-conflicted`. Still open: should Morpho or the curators be told?

P2-3. **Undetectable cases.** Oracles for tokens with multiplier exactly 1 (SPCX, COIN) cannot be tested for double application until their multiplier moves. Re-check on every `UIMultiplierUpdated`? One NVDA market (`0xbe3a5355…`) is INCONCLUSIVE: needs manual review of its oracle.

P2-9. **USDG-pegged oracles.** *Decided in Phase 3:* not an exclusion. They are shown with the risk fact and the `ORACLE_ASSUMES_LOAN_PEG` warning.

P2-4. **Rewards completeness.** The Morpho API misses external (Merkl) campaigns. Is Merkl acceptable as a rewards source for the Morpho adapter, or does it need its own adapter and approval?

P2-5. **Safety-buffer model.** Only the protocol maximum borrow (at LLTV) is computed. What buffer policy (if any) should the product present?

P2-6. **Steakhouse USDG `deposit_disabled`.** *Decided in Phase 3:* not actionable by default (lifecycle blocker DEPOSIT_DISABLED → excluded). Still open: whether it is Robinhood-app-only.

P2-7. **API state lag.** Idle-market APY state can be tens of minutes old (freshness AGING/STALE). Acceptable, or should we compute APY onchain from the IRM (float needed for e^x, or a fixed-point exp)?

P2-8. **BORROW category.** Not emitted separately (it is COLLATERAL seen from the collateral side). Does the UI need a "borrow X" entry point for users who don't hold collateral yet?

## Added in Phase 1 (decide before Phase 2)
P1-1. **Unknown-token discovery.** Phase 1 scans only the canonical registry (195 Stock Tokens + ETH/WETH/USDG); other tokens appear only if named explicitly (`--token`). Full discovery needs an indexer: Alchemy Token API (`alchemy_getTokenBalances`, documented for 4663, key needed), Goldsky, Envio, or our own Transfer indexer. Which one, and do unknown tokens matter for the product?

P1-2. **Provider choice** (restates #1): the engine refuses the public RPC in production. Alchemy or QuickNode?

P1-3. **USDG cross-check.** Should a DEX-implied USDG price (for example the WETH/USDG 0.01 % pool × ETH/USD) be added as a depeg cross-check? That touches Uniswap pool reads, which are Phase 2 territory.

P1-4. **Frozen / blocked holders.** Paxos can freeze USDG (`isFrozen`) and Robinhood can block Stock Token holders (`isBlocked`). Should the portfolio check both per wallet (2 extra calls) and mark such balances as not spendable?

P1-5. **Market hours.** Chainlink stock feeds hold the last price while markets are closed, and the Robinhood bulk quote stamps `generatedAt` continuously. Neither tells us "market closed". Should the UI say "last traded price" outside US hours? That needs a market-calendar source.

P1-6. **Quote endpoint.** We use bulk `GET /rhj/prices` (live-verified, not in the docs) to avoid N+1 per-symbol calls. Is Robinhood OK with that for production volume (documented limit 60 req/s)?

P1-7. **Conflict threshold.** 1.0 % between Chainlink and the Robinhood-implied price. The observed maximum was 0.41 %. Keep it, or tighten it during market hours?

P1-8. **Registry refresh ownership.** Who reviews `pnpm registry:check` failures (identity changes) before `--accept-identity-changes`?

## Needs a decision from you
1. **Keyed RPC provider.** Alchemy (official "recommended") or QuickNode (documented archive)? Needed before Phase 1 goes beyond the validation scripts.
2. **Product name and legal posture.** The working name "defi-router" is internal only. Robinhood's ToS forbid "Robinhood Chain" as a product name and require "Stock Tokens" wording. Stock Tokens are not offered to US persons: will the app geo-gate, show a disclaimer, or both?
3. **Curation defaults.** Hide Morpho unlisted markets by default? Hide Pendle long-tail markets (sNET at about 10,000 % implied)? Our recommendation is yes to both, with an explicit toggle.
4. **Offchain venues.** Should Lighter (offchain matching) and Rialto (keyed quotes) appear under TRADE as "also tradable on", without depth?
5. **"Holding" yield tokens.** Do syrupUSDG and mGLO count as YIELD opportunities, given they cannot be minted on 4663?

## Needs more research
6. **Deep-link host allowlists.** No protocol app domain was verified from official docs, so `linkHosts` is empty everywhere. Resolve by reading each protocol's docs for its app URL (Morpho, Spark, Pendle, Uniswap, Beefy, Steer).
7. **ERC-8056 switch-over.** Does `uiMultiplier()` flip to `newUIMultiplier` automatically at `effectiveAt`? Resolve by reading the EIP-8056 text and watching the next scheduled `UIMultiplierUpdated`.
8. **Feed includes multiplier: stronger proof.** Wait for a Chainlink feed on a token with a large multiplier (e.g. CRWD at 4.0), or ask Chainlink/Robinhood. `pnpm validate:oracles` re-tests this every run.
9. **Morpho double-multiplier oracles.** Who deployed the six oracles, and is there source code? Until then they are flagged `DOUBLE_APPLIED` (measured) and the markets carry a CONFLICT warning.
10. **Steakhouse USDG `deposit_disabled`.** Is the vault restricted to Robinhood app users? Resolve with Morpho or Steakhouse docs, or onchain gate history.
11. **Pendle Stock Token SY yield.** *Partly resolved in Phase 3:* yes. `SY.exchangeRate() == uiMultiplier` exactly at the same block for NVDA and SGOV, and the API says `pyUnit: "NVDA Shares"`. The remaining question is P3-1.
12. **v4 TVL for hooked pools.** How do we value pools whose hooks move balances outside PoolManager (Fables, Doppler)? For now they are shown without TVL.
13. **GeckoTerminal v4 reserves.** Why are they 12–15 % above the principal replay?
14. **Arcadia pool addresses** from official docs (the factory is verified; the pools come from the DefiLlama adapter).
15. **T3tris / D2 / StonkBrokers** official address sources.
16. **Alchemy Portfolio API** support for 4663 (needed only if we want balances of tokens outside the registry).
17. **Chainlink sequencer-uptime feed** for 4663. The docs recommend one; none is listed.
18. **Stock Token blocklist.** Should the portfolio flag a wallet that is blocked (`isBlocked`) the same way as a frozen USDG holder?
