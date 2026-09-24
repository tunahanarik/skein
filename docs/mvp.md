# MVP plan

**Read-only.** No signing, approvals, deposits, withdrawals, borrowing, swaps, LP creation or transaction submission. The codebase contains no wallet client.

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 0 | research, live validation, data model | done (commit `d49ff0c`) |
| 1 | **Portfolio Engine + Asset Registry + Price Service** (no opportunities, no UI) | done; see [portfolio-engine.md](portfolio-engine.md), [asset-registry.md](asset-registry.md), [pricing.md](pricing.md), [rpc.md](rpc.md) |
| 2 | **Opportunity Engine + Morpho adapter** (read-only; no UI) | done; see [opportunity-engine.md](opportunity-engine.md), [protocol-adapters.md](protocol-adapters.md), [protocols/morpho-adapter.md](protocols/morpho-adapter.md), [opportunity-provenance.md](opportunity-provenance.md) |
| 2b | further adapters (Pendle → Spark → Uniswap …) | not started; needs approval |
| 3 | minimal comparison UI | not started |

The items below are the original product flow. Steps 1–3 (wallet, asset detection, portfolio value) are what Phase 1 delivered, through the CLI. Steps 4–9 belong to later phases.

## User flow
1. Connect wallet: read the address only, validate it, require chain 4663 (or accept a pasted address).
2. Detect assets: Multicall3 scan of canonical Stock Tokens + WETH + USDG + ETH at one block.
3. Portfolio value: per asset, tokens held, share-equivalent (Stock Tokens) and USD with its price source and age. Unpriced assets are shown as unpriced.
4. Select an asset.
5. Discover verified opportunities for it.
6. Categorize: TRADE · LEND · BORROW · COLLATERAL · LP · VAULT · FIXED_YIELD · YIELD.
7. Compare: sort by the user's chosen metric (APY, TVL, liquidity). No blended "best".
8. Show source, freshness, verification badge and RiskMetadata facts for every number.
9. Deep-link to the protocol only through `toTrustedLink` with a verified host allowlist (to be filled, see open questions). Otherwise show the contract address and no link.

## Coverage the MVP can honestly deliver today

| Category | Stock Tokens (e.g. NVDA) | USDG | WETH/ETH |
|---|---|---|---|
| TRADE | Uniswap v3/v4 pools (onchain), depth via quoter probes; Lighter/Rialto listed as "also tradable on" (no depth) | Uniswap pools | Uniswap pools |
| LEND | – (Stock Token *loan* markets exist but are empty) | Morpho listed markets; Arcadia later | Morpho (WETH loan markets, small) |
| BORROW | show "borrow USDG against NVDA" (from the COLLATERAL side) | Morpho borrow APY | Morpho |
| COLLATERAL | Morpho NVDA/AAPL/TSLA/GOOGL/SPY… markets: **unlisted, tiny; shown with warnings; double-multiplier oracles flagged** | USDe/syrupUSDG/mGLO/spUSDG → n/a (USDG is the loan side) | Morpho WETH collateral markets |
| LP | Uniswap pools; Steer/Beefy vaults where the pair includes the token | Uniswap, Beefy CLM, Steer | Uniswap, Beefy CLM |
| VAULT | – (Morpho Stock Token vaults are $0) | Morpho Vault V2 (Steakhouse etc.), Spark spUSDG | Morpho WETH vaults (empty) |
| FIXED_YIELD | **Pendle PT-NVDA / PT-PFE / PT-SGOV** (fixed in token units) | Pendle USDG market (unlisted, hidden) | – |
| YIELD | Pendle YT | Spark Savings 3.50 % | – |

## Phase 1 build list
1. `packages`: keep a single package for now: `src/` (model, lib, sources, protocols, engines) and `app/` (Next.js).
2. Asset Registry + Portfolio Engine + Price Service (all core math already exists and is tested).
3. Adapters, in this order: **Morpho** (largest, best API) → **Spark** → **Pendle** → **Uniswap v3** → Uniswap v4 (curated pool registry job) → Beefy → Steer. Merkl as reward enricher.
4. Risk Metadata Service: oracle classification (Morpho `oracle.type` + our multiplier check), asset controls (Stock Token pause/blocklist, USDG freeze), protocol warnings passthrough.
5. PostgreSQL snapshot store + Redis cache; keyed RPC.
6. Minimal UI: portfolio list → asset page → opportunity table with source/freshness popovers. No design polish.
7. Tests: adapter normalization against recorded API fixtures from `research/evidence/`.

## Explicitly out of scope for Phase 1
Execution of any kind, perps (Lighter, Arcus), launchpads, unknown-token discovery beyond the registry, historical charts, alerts, risk scoring.

## Legal and product gates before any public launch
- Stock Tokens are not offered to US persons and are restricted in several jurisdictions. Even a read-only discovery product needs a jurisdiction and disclaimer decision.
- Branding: the product may not be named "Robinhood Chain …", must say "Stock Tokens", and must not imply endorsement ([ToS 5.6–5.7](https://docs.robinhood.com/chain/terms-of-service)).
