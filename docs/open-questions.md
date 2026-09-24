# Open questions

Each item names what would resolve it.

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
11. **Pendle Stock Token SY yield.** Does SY accounting include the uiMultiplier (exchangeRate 1.000775 = NVDA multiplier) while the API says `underlyingApy` is 0?
12. **v4 TVL for hooked pools.** How do we value pools whose hooks move balances outside PoolManager (Fables, Doppler)? For now they are shown without TVL.
13. **GeckoTerminal v4 reserves.** Why are they 12–15 % above the principal replay?
14. **Arcadia pool addresses** from official docs (the factory is verified; the pools come from the DefiLlama adapter).
15. **T3tris / D2 / StonkBrokers** official address sources.
16. **Alchemy Portfolio API** support for 4663 (needed only if we want balances of tokens outside the registry).
17. **Chainlink sequencer-uptime feed** for 4663. The docs recommend one; none is listed.
18. **Stock Token blocklist.** Should the portfolio flag a wallet that is blocked (`isBlocked`) the same way as a frozen USDG holder?
