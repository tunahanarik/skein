# Skein

Onchain intelligence for Robinhood Chain. Who holds what, what they do with it, and what any wallet *could* do with it, with the source, age and verification status of every number.

Today Skein reads every canonical asset of Robinhood Chain (195 Stock Tokens, USDG, ETH/WETH and a few crypto tokens) and the protocols around them. Protocols covered:
- Uniswap v3 and v4 (hookless pools only)
- Ramses CL
- Morpho
- Pendle
- Spark Savings
- Beefy CLM
- Steer

For any wallet it shows holdings (Stock Tokens in share-equivalents), protocol positions, and the opportunities that are actually available: trade, earn, borrow and provide liquidity.

Skein is read-only end to end. The server holds no keys, and the web app never builds, signs or sends a transaction. Connecting a wallet only reads its address.

Where this is going: [docs/plan/roadmap.md](docs/plan/roadmap.md) (an Arkham-style intelligence platform, Robinhood Chain first) and [docs/plan/arkham.md](docs/plan/arkham.md).

## Layout

A pnpm workspace of small libraries (`packages/*`) and the apps that run them (`apps/*`). Rules, layering and "where does a new thing go" are in [docs/structure.md](docs/structure.md).

```
apps/server        HTTP API + web app server         apps/web           React + Vite app
apps/cli           CLIs and live validation scripts
packages/core      model, exact math, provenance     packages/networks  network definitions
packages/chain     read-only RPC (ChainReader)       packages/robinhood Robinhood Chain registry, sources, deployments
packages/pricing   Price Service                     packages/portfolio Portfolio Engine
packages/engine    Opportunity Engine + routing      packages/protocols protocol adapters, one folder each
packages/product   product read layer                packages/runtime   composition root
packages/testkit   offline fixtures
docs/  research/  brand/  test/integration/  tools/
```

## Commands

Run every command from the repository root.

```bash
pnpm install
pnpm start                      # build the web app and serve it with the API on http://127.0.0.1:8787
pnpm web:dev                    # web dev server on :5173 (run `pnpm serve` alongside)
pnpm check                      # dependency rules + typecheck + all offline tests
pnpm test                       # unit (packages/*/test, apps/*/test) + integration (test/integration)
pnpm typecheck
pnpm check:deps                 # workspace dependency rules (tools/check-deps.mjs)
pnpm validate                   # all live read-only checks
pnpm asset NVDA [--json]        # what can be done with NVDA
pnpm asset NVDA --to USDG --amount 1
pnpm portfolio:view --address 0x… [--json]
pnpm coverage [--json]          # coverage matrix for all canonical assets
pnpm opportunities [--asset NVDA|0x…] [--address 0x…] [--category FIXED_YIELD] [--json]
pnpm trade:inspect --from NVDA --to USDG [--amount 1]
pnpm registry:check             # diff the live Stock Token registry against the committed snapshot
pnpm uniswap:index              # one-time Uniswap pool-event index (.cache/, not committed)
```

The full list of live checks (`validate:*`) is in `package.json`.

Set `ROBINHOOD_RPC_URL` (see `.env.example`) to use a keyed provider; production refuses to start without one. `ROBINHOOD_INDEX_RPC_URL` optionally sends log indexing to a separate endpoint. No private key is ever needed.

## Docs

| Topic | Docs |
|---|---|
| Plan | [plan/roadmap.md](docs/plan/roadmap.md), [plan/arkham.md](docs/plan/arkham.md), [open-questions.md](docs/open-questions.md) |
| Code structure | [structure.md](docs/structure.md) |
| Engine | [architecture.md](docs/architecture.md) (original design and phase notes), [portfolio-engine.md](docs/portfolio-engine.md), [pricing.md](docs/pricing.md), [opportunity-engine.md](docs/opportunity-engine.md), [asset-intelligence.md](docs/asset-intelligence.md) |
| Protocols | [protocol-adapters.md](docs/protocol-adapters.md), [protocols/](docs/protocols/) |
| API | [api.md](docs/api.md) |
| Research | [research/](docs/research/), raw evidence in `research/evidence/` |

## Terms

Robinhood Chain brand rules apply:
- Always write "Robinhood Chain" in full.
- Always write "Stock Tokens", never "tokenized stocks".

This project is not affiliated with Robinhood.
