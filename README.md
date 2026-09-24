# defi-router (working name)

Read-only DeFi opportunity discovery for Robinhood Chain assets: "I hold NVDA / USDG / ETH; what can I do with them?"

**Status: Phase 1 done: Portfolio Engine, Asset Registry and Price Service.** There is no UI (only a developer CLI), no opportunities yet, and no execution. The code cannot sign anything. See [docs/mvp.md](docs/mvp.md).

## Layout
```
docs/                     research (network, stock-tokens, usdg, protocols, morpho, pendle, dex, indexing),
                          architecture, data-sources, mvp, open-questions
src/chain/                ChainReader (read-only RPC abstraction), retries, health, RPC config
src/registry/             Asset model, Robinhood registry ingestion, snapshot, change detection, unknown tokens
src/pricing/              Price Service (Chainlink → Robinhood quote fallback), freshness, conflicts
src/portfolio/            balance reader + Portfolio Engine
src/model/                Opportunity, RiskMetadata, provenance (DataSource / Sourced<T>), verification states, warning codes
src/lib/                  exact decimal math, Stock Token balance + valuation, rates, freshness, validation, trusted links
src/sources/              zod schemas for the Robinhood Stock Token API and the Chainlink directory
src/config/               verified-only registries: chains, assets, protocols, ABIs
src/protocols/types.ts    protocol adapter interface
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
pnpm test                       # unit + integration tests (offline)
pnpm typecheck
pnpm validate                   # all live checks: Phase 0 + Phase 1 (read-only)
pnpm validate:portfolio         # Phase 1 live checks only
pnpm portfolio --address 0x…    # portfolio CLI (--json, --include-zero, --token 0x…)
pnpm registry:check             # diff live Stock Token registry vs committed snapshot
```

Set `ROBINHOOD_RPC_URL` (see `.env.example`) to use a keyed provider. The public RPC is rate-limited and officially not for production. No private key is ever needed.

## Terms
Robinhood Chain brand rules apply: use "Robinhood Chain" in full and "Stock Tokens" (never "tokenized stocks"). This project is not affiliated with Robinhood.
