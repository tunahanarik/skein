# Skein

Onchain intelligence for Robinhood Chain (Arkham-style, Robinhood Chain first, more networks later). Plan: docs/plan/roadmap.md. Structure: docs/structure.md (read it before adding a package or moving code).

## Workspace rules
- pnpm workspace: libraries in `packages/*`, runnable apps in `apps/*`. Libraries never import apps.
- Cross-package imports use the package name and the path under `src`, without extension: `@skein/core/lib/cache`. Inside a package use relative paths with `.js` (NodeNext).
- Every import in `src/` must be declared in that package's `package.json`; no cycles. `pnpm check:deps` enforces this.
- `@skein/core` and `@skein/networks` import no other `@skein` package; `@skein/chain` only those two.
- Anything specific to Robinhood Chain goes in `@skein/robinhood` (or `@skein/networks` for the chain definition), not in core.
- Unit tests live in `<package>/test`; cross-package tests in `test/integration`; fixtures in `@skein/testkit`.
- Run commands from the repo root. Before finishing a change: `pnpm check` (deps + typecheck + tests).

## Product rules
- Read-only end to end: the server holds no keys and the web app never builds, signs or sends a transaction (swap and bridge were removed on purpose). The wallet connection may only read the address and chain id.
- Every number carries its source, freshness and verification status. Nothing from an API is published without an onchain check.
- No risk scores or blended "best" rankings. Do not deanonymize individuals; label only organizations, contracts and self-declared entities.
- Brand: write "Robinhood Chain" in full and "Stock Tokens" (never "tokenized stocks"). Not affiliated with Robinhood.

## Docs language
Planning docs (docs/plan, docs/structure.md) are in Turkish. Code, comments and technical docs are in English.
