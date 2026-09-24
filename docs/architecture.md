# Proposed architecture

The architecture follows from the research: which sources exist, how fast they are, and which ones we can trust. Differences from the initial sketch are marked **(changed)**.

```
Wallet (read-only address; no signing in Phase 1)
  │  parseWalletAddress + chain id 4663 check
  ▼
Portfolio Engine ─────────────► Asset Registry  (changed: registry comes BEFORE the portfolio)
  │  Multicall3 aggregate3 over      │  canonical set = /rhj/assets ∩ onchain identity check
  │  the registry at ONE block       │  + static core assets (WETH, USDG)
  │  balance, uiMultiplier           │  address is identity; symbols display-only
  ▼                                  ▼
Price Service ◄──────────────── Chainlink feeds · /rhj/prices · DEX mids (cross-check only)
  │  every price = Sourced<T>: value, source, block, sourceTimestamp, verification
  ▼
Opportunity Engine
  │  asks each adapter for getAssetOpportunities(asset)
  │  merges, dedupes by deterministic id, applies curation filters
  │  (listed-only default, expired hidden, unverified flagged)
  ▼
Protocol Adapters  morpho · pendle · spark · uniswap · beefy · steer · (merkl = reward enricher)
  │  normalize raw protocol data → Opportunity (src/model/opportunity.ts)
  ▼
Risk Metadata Service  (changed: separate, shared)
  │  oracle review (kind, feeds, multiplier handling), asset controls (pause/freeze/blocklist),
  │  upgradeability, protocol warnings, reward dependence. Facts only, no score.
  ▼
Snapshot Store (PostgreSQL)  (changed: added — provenance needs history)
  │  every served value + its DataSource, so "how old / where from" is answerable
  ▼
API (read-only) ──► Comparison UI (Next.js)
```

## Why these changes
1. **Asset Registry before the Portfolio Engine.** A wallet has no "list of tokens" we can ask for without an indexer. We scan a known list: 195 Stock Tokens + core assets, one Multicall3 call, about 0.5 s. So the registry defines what the portfolio can see.
2. **Price Service is separate from the adapters.** Stock Token pricing is easy to get wrong (multiplier applied twice or not at all). It lives in one tested module (`src/lib/stockToken.ts`) that has two price *types*, and adapters never price assets themselves.
3. **Risk Metadata Service is shared.** The same oracle and asset-control facts (for example "this oracle double-applies uiMultiplier", "USDG can be frozen by Paxos") apply across adapters.
4. **Snapshot store from day one.** Provenance is a requirement, and several protocols give no history (Spark, onchain-only metrics).

## Components

| Component | Runtime | Responsibility | Sources |
|---|---|---|---|
| Frontend | Next.js + TypeScript + wagmi + viem | connect wallet (read the address only), show portfolio, opportunities, comparison, source/freshness badges | our API only (no direct third-party calls from the browser) |
| API | Next.js route handlers or a small Node service | read-only endpoints: `/portfolio/:address`, `/assets/:address/opportunities`, `/opportunities/:id` | engines below |
| Asset Registry | server, cached | canonical Stock Tokens (+ status transitions), core assets, Chainlink feed mapping | `/rhj/assets`, onchain, Chainlink directory |
| Portfolio Engine | server | balances + multipliers at a pinned block; display balance + share-equivalent | keyed RPC, Multicall3 |
| Price Service | server | token prices with provenance + staleness + cross-check | Chainlink, `/rhj/prices`, DEX |
| Opportunity Engine | server | fan out to adapters, merge, filter, rank by *user-chosen* metric | adapters |
| Protocol Adapters | server | one per protocol, capability-flagged (`src/opportunities/adapter.ts`) | protocol APIs + onchain |
| Risk Metadata | server | objective attributes (`OpportunityRisk` in `src/model/opportunity.ts`; Phase 2: produced inside adapters, shared service later) | onchain, protocol APIs |
| Cache | Redis | short TTL: prices ≈15–60 s, protocol API ≈60 s, registry ≈5 min; request coalescing to respect rate limits | – |
| Store | PostgreSQL | snapshots of served values, v4 pool registry, registry history | – |
| Jobs | cron/worker | registry refresh, v4 `Initialize` log follower, snapshotting | keyed RPC |

## Trust boundaries
- Everything from APIs is untrusted input: parsed with zod, addresses checksummed, links passed through `toTrustedLink` against per-protocol host allowlists (empty until verified).
- The browser never receives provider keys. RPC and API keys live only on the server.
- There is no write path to chain in Phase 1: no wallet client exists in the codebase.

## Phase 2 status
Implemented as proposed, with one refinement: user-aware context (`PortfolioOpportunity`) is built from the canonical opportunity fields only. `LiquidationTerms.collateralPrice` carries the protocol's own collateral→loan conversion, so the engine computes protocol maximum borrow without protocol code. See [opportunity-engine.md](opportunity-engine.md) and [protocol-adapters.md](protocol-adapters.md).

## Phase 3 status
Pendle was added as an ordinary adapter. The engine gained only generic concepts, and none of them read `details`:
- `Lifecycle` (maturity against the pinned block)
- `EntryRequirement`
- `LiquidityKind`
- `AssetRelationship`
- the eligibility layer (`src/opportunities/eligibility.ts` + `src/config/eligibility.ts`)
- comparison groups

`ChainReader` gained `getLogs` (range bisection) for onchain discovery. See [protocols/pendle-adapter.md](protocols/pendle-adapter.md).

## Phase 4 status
Uniswap v3 was added as the first TRADE adapter, through the same interface. The generic additions are:
- the trade model: TradeMarket / TradeRoute / TradeQuote (`src/model/trade.ts`)
- a venue-independent trade graph and router (`src/trade/`)
- engine trade methods
- the TRADE portfolio context
- the eligibility reasons DUST_LIQUIDITY, UNRESOLVED_YIELD_SEMANTICS and LIQUIDITY_UNVERIFIED

`ChainReader.getLogs` gained topic filters, an unbatched log client and a sub-request budget. See [trade-opportunities.md](trade-opportunities.md), [trade-routing.md](trade-routing.md) and [protocols/uniswap-adapter.md](protocols/uniswap-adapter.md).

## Protocol adapter system

```
src/protocols/
  morpho/           IMPLEMENTED (Phase 2): API + onchain identity/totals; markets → LEND/COLLATERAL, vaultV2 → VAULT
                    (interface: src/opportunities/adapter.ts)
  pendle/           IMPLEMENTED (Phase 3): factory CreateNewMarket logs → onchain identity/state + API /v1/{chain}/markets/{addr} → FIXED_YIELD, YIELD, LP; positions
  spark/            onchain vsr/totalAssets → YIELD (savings)
  uniswap/          IMPLEMENTED (Phase 4): v3 factory PoolCreated logs → verified pools → TRADE; QuoterV2 indicative quotes (v2/v4 researched, not integrated)
  beefy/            API cow-vaults/vaults + apy → LP/VAULT
  steer/            API getAprs + onchain getTotalAmounts → LP/VAULT
  merkl/            not an adapter: enriches Opportunity.yield.rewards by (protocol, venue)
```

Rules:
- An adapter implements only the methods its protocol supports, and says so in `capabilities`. For example, Spark has no user-position API; the engine then reads `balanceOf(spUSDG)`.
- Adapters return `AdapterResult` with `issues[]` and never throw for missing data. A partial answer is still shown, status PARTIAL.
- Every metric is `Measured<T> | null`. A metric the protocol doesn't provide is `null`, never 0.
- `Opportunity.verificationStatus` = the weakest status among asset identities, onchain totals and yields; CONFLICT on identity conflicts or double-applied oracles.
