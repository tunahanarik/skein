# defi-router (working name)

Read-only DeFi opportunity discovery for Robinhood Chain assets: "I hold NVDA / USDG / ETH; what can I do with them?"

Protocols read today: Uniswap v3 and v4 (hookless), Ramses CL, Morpho, Pendle, Spark Savings, Beefy CLM and Steer. See [docs/protocols/coverage-expansion.md](docs/protocols/coverage-expansion.md).

**Status: Phase 6: web app + HTTP API** (`pnpm start` → http://127.0.0.1:8787; see [docs/api.md](docs/api.md)). Before that, **Phase 5: product read API** ("I own this asset. What can I actually do with it?"): AssetIntelligence / PortfolioIntelligence / coverage as a projection of the raw engine, with usability, per-category ranking, data quality and freshness. It sits on top of Phase 4 (Uniswap v3 TRADE), Phase 3 (Pendle), Phase 2 (Morpho) and Phase 1 (portfolio, registry, prices). Still read-only: no swaps, approvals, signatures or transactions. There is no execution. The code cannot sign anything. See [docs/mvp.md](docs/mvp.md).

## Layout
```
docs/                     research (network, stock-tokens, usdg, protocols, morpho, pendle, dex, indexing),
                          architecture, data-sources, mvp, open-questions
src/chain/                ChainReader (read-only RPC abstraction), retries, health, RPC config
src/registry/             Asset model, Robinhood registry ingestion, snapshot, change detection, unknown tokens
src/pricing/              Price Service (Chainlink → Robinhood quote fallback), freshness, conflicts
src/portfolio/            balance reader + Portfolio Engine
src/opportunities/        Opportunity Engine, adapter interface, filters/sorting, user-aware context
src/protocols/morpho/     Morpho adapter (API client, onchain reads, normalization, oracle check, vaults, positions)
src/protocols/pendle/     Pendle adapter (onchain discovery via factory logs, identity checks, API client, PT/YT/LP normalization, positions)
src/protocols/uniswap/    v3-style adapter (dialects: Uniswap v3, Ramses CL) + Uniswap v4 hookless adapter (tick-walk reserves, V4Quoter)
src/protocols/ramses/     Ramses CL dialect (official addresses, dynamic fee)
src/protocols/spark/      Spark Savings (spUSDG) adapter (vsr, exact rpow)
src/protocols/beefy/      Beefy CLM adapter (API candidates, onchain identity, onchain TVL)
src/protocols/steer/      Steer v3 vault adapter (VaultRegistry + pool checks)
src/protocols/shared/     managed-LP helpers (official v3 pool verification)
src/sources/geckoterminal.ts  third-party 24h pool volume (display only)
src/trade/                generic trade graph, DIRECT/ONE_HOP routing, quote comparison (venue-independent)
src/product/              Phase 5 product read API: AssetIntelligenceService, usability, cards, ranking, quality, metrics
src/server/               Phase 6 read-only HTTP API (node:http), rate limiting, static web app with strict CSP
web/                      Phase 6 web app (React + Vite): explore, asset, wallet, coverage
src/model/                Opportunity, RiskMetadata, provenance (DataSource / Sourced<T>), verification states, warning codes
src/lib/                  exact decimal math, Stock Token balance + valuation, rates, freshness, validation, trusted links
src/sources/              zod schemas for the Robinhood Stock Token API and the Chainlink directory
src/config/               verified-only registries: chains, assets, protocols, ABIs
scripts/                  read-only live validation scripts
research/unverified.json  candidates that are NOT in production config
research/evidence/        curated raw evidence from the 2026-09-24 research
research/snapshots/       output of the last validation run
data/registry/            committed, hash-checked Stock Token registry snapshot (baseline)
test/unit, test/integration  offline tests (fixture world in test/fixtures)
```

## Commands
```bash
pnpm install
pnpm start                      # build the web app and serve it with the API on http://127.0.0.1:8787
pnpm web:dev                    # web dev server on :5173 (run `pnpm serve` alongside)
pnpm test                       # unit + integration tests (offline)
pnpm typecheck
pnpm validate                   # all live checks: Phase 0–5 (read-only)
pnpm validate:portfolio         # Phase 1 live checks only
pnpm portfolio --address 0x…    # portfolio CLI (--json, --include-zero, --token 0x…)
pnpm registry:check             # diff live Stock Token registry vs committed snapshot
pnpm opportunities [--asset NVDA|0x…] [--address 0x…] [--json]   # opportunity CLI (default eligibility view)
     [--protocol pendle] [--category FIXED_YIELD] [--include-expired] [--include-conflicted] [--debug]
     [--maturity-after YYYY-MM-DD] [--maturity-before YYYY-MM-DD] [--sort IMPLIED_APY:DESC|MATURITY]
pnpm validate:opportunities     # Phase 2 live checks only
pnpm validate:pendle            # Phase 3 live checks (Pendle adapter + combined engine)
pnpm validate:pendle:research   # Phase 0 Pendle research checks
pnpm opportunities --asset NVDA --category TRADE        # where can NVDA be traded
pnpm opportunities --asset NVDA --to USDG [--amount 1]  # routes (+ INDICATIVE quotes with an explicit amount)
pnpm trade:inspect --from NVDA --to USDG [--amount 1]   # developer view of candidate markets and routes
pnpm uniswap:index              # finish the one-time Uniswap pool-event index (.cache/, not committed)
pnpm validate:uniswap           # Phase 4 live checks (Uniswap + combined three-protocol view)
pnpm asset NVDA [--json] [--debug]              # Phase 5: what can be done with NVDA (product view)
pnpm asset NVDA --to USDG --amount 1            # … with indicative quotes for exactly 1 NVDA
pnpm portfolio:view --address 0x… [--json]      # per held asset (address never persisted)
pnpm coverage [--json]                          # coverage matrix for all canonical assets
pnpm validate:intelligence      # Phase 5 live checks
```

Set `ROBINHOOD_RPC_URL` (see `.env.example`) to use a keyed provider; production refuses to start without one. `ROBINHOOD_INDEX_RPC_URL` optionally sends log indexing to a separate endpoint. The public RPC is rate-limited and officially not for production. No private key is ever needed.

## Terms
Robinhood Chain brand rules apply: use "Robinhood Chain" in full and "Stock Tokens" (never "tokenized stocks"). This project is not affiliated with Robinhood.
