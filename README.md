# defi-router (working name)

Read-only DeFi opportunity discovery for Robinhood Chain assets: "I hold NVDA / USDG / ETH; what can I do with them?"

**Status: Phase 0 (research, live-chain validation, data model).** There is no UI and no execution, and the code cannot sign anything. See [docs/mvp.md](docs/mvp.md) for the proposed Phase 1.

## Layout
```
docs/                     research (network, stock-tokens, usdg, protocols, morpho, pendle, dex, indexing),
                          architecture, data-sources, mvp, open-questions
src/model/                Opportunity, RiskMetadata, provenance (DataSource / Sourced<T>), verification states
src/lib/                  exact decimal math, Stock Token balance + valuation, rates, freshness, validation, trusted links
src/sources/              zod schemas for the Robinhood Stock Token API and the Chainlink directory
src/config/               verified-only registries: chains, assets, protocols, ABIs
src/protocols/types.ts    protocol adapter interface
scripts/                  read-only live validation scripts
research/unverified.json  candidates that are NOT in production config
research/evidence/        curated raw evidence from the 2026-09-24 research
research/snapshots/       output of the last validation run
test/                     unit tests for the normalization math
```

## Commands
```bash
pnpm install
pnpm test               # unit tests
pnpm typecheck
pnpm validate           # all live checks against Robinhood Chain (read-only)
pnpm portfolio 0x…      # value a wallet's canonical assets, with sources
```

Set `ROBINHOOD_RPC_URL` (see `.env.example`) to use a keyed provider. The public RPC is rate-limited and officially not for production. No private key is ever needed.

## Terms
Robinhood Chain brand rules apply: use "Robinhood Chain" in full and "Stock Tokens" (never "tokenized stocks"). This project is not affiliated with Robinhood.
