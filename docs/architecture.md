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
| Protocol Adapters | server | one per protocol, capability-flagged (`src/protocols/types.ts`) | protocol APIs + onchain |
| Risk Metadata | server | objective attributes (`src/model/risk.ts`) | onchain, protocol APIs |
| Cache | Redis | short TTL: prices ≈15–60 s, protocol API ≈60 s, registry ≈5 min; request coalescing to respect rate limits | – |
| Store | PostgreSQL | snapshots of served values, v4 pool registry, registry history | – |
| Jobs | cron/worker | registry refresh, v4 `Initialize` log follower, snapshotting | keyed RPC |

## Trust boundaries
- Everything from APIs is untrusted input: parsed with zod, addresses checksummed, links passed through `toTrustedLink` against per-protocol host allowlists (empty until verified).
- The browser never receives provider keys. RPC and API keys live only on the server.
- There is no write path to chain in Phase 1: no wallet client exists in the codebase.

## Protocol adapter system

```
src/protocols/
  types.ts          ProtocolAdapter, AdapterContext, AdapterResult, UserPosition
  morpho/           API (GraphQL) + onchain spot-check; markets → LEND/BORROW/COLLATERAL, vaultV2 → VAULT
  pendle/           API /v2/markets/all + onchain readTokens/expiry → FIXED_YIELD, YIELD, LP
  spark/            onchain vsr/totalAssets → YIELD (savings)
  uniswap/          getPool (v3), curated v4 pool registry + StateView → TRADE, LP
  beefy/            API cow-vaults/vaults + apy → LP/VAULT
  steer/            API getAprs + onchain getTotalAmounts → LP/VAULT
  merkl/            not an adapter: enriches Opportunity.yield.rewards by (protocol, venue)
```

Rules:
- An adapter implements only the methods its protocol supports, and says so in `capabilities`. For example, Spark has no user-position API; the engine then reads `balanceOf(spUSDG)`.
- Adapters return `AdapterResult` with `errors[]` and never throw for missing data. A partial answer is still shown, marked DEGRADED.
- Every metric is `Sourced<T> | null`. A metric the protocol doesn't provide is `null`, never 0.
- `Opportunity.verification` = the weakest status among yield, TVL and contracts (`weakestStatus`).
