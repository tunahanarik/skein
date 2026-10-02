# Asset Registry

`packages/robinhood/src/registry/`. It defines which assets are canonical and therefore scanned, and how changes upstream are detected.

## Identity
- **Identity = chainId + contract address** (key `4663:<lowercase address>`; native ETH is `4663:native`). Symbols and names are display-only and sanitized (control/bidi characters stripped, length capped).
- Addresses are checksummed for output. Lookups are case-insensitive.

## Asset model (`packages/robinhood/src/registry/asset.ts`)

| Field | Notes |
|---|---|
| `type` | `NATIVE` · `STOCK_TOKEN` · `STABLECOIN` · `WRAPPED_NATIVE` · `ERC20` · `UNKNOWN` |
| `canonical` | true only for core config assets and Robinhood-listed ACTIVE Stock Tokens without an unresolved identity change or onchain mismatch |
| `verificationStatus` | `VERIFIED_ONCHAIN` after the onchain identity check, `VERIFIED_OFFICIAL_API` before it, `CONFLICT` on mismatch, `UNVERIFIED` for unknown tokens |
| `stockMetadata` | `uid`, `rhSymbol`, `isin`, `registryMultiplierE18`, pending multiplier + time, status, CDN-only logo URL |
| `priceMethods` | ordered methods the Price Service may use |
| `provenance` | registry source (live API or snapshot + hash) + onchain check |

## Sources
| Asset | Source |
|---|---|
| ETH (native) | Phase 0 config (docs /chain/connecting) |
| WETH `0x0Bd7…AD73` | Phase 0 config (docs /chain/protocol-contracts, verified onchain) |
| USDG `0x5fc5…d168` | Phase 0 config (Paxos USDG mainnet list, verified onchain) |
| Stock Tokens | **not hardcoded**: `GET https://api.robinhood.com/rhj/assets` |

## Ingestion pipeline (`robinhoodRegistry.ts`)
1. `fetchRobinhoodAssetRegistry(http)`: 15 s timeout, 2 MB cap, zod schema. No credentials are sent and redirects are refused.
2. `normalizeRobinhoodAsset(a)` excludes an entry with no 4663 deployment, several 4663 addresses, or an unparseable multiplier. It flags non-18 decimals and a bad pending multiplier.
3. `validateRobinhoodAssetRegistry(raw)`:
   - Non-ACTIVE entries are excluded.
   - A **duplicate address, uid or symbol excludes every entry involved**, because we can't tell which one is real.
4. `cacheRobinhoodAssetRegistry(http)`: in-memory TTL cache (5 min), with concurrent requests coalesced.
5. `loadAssetRegistry(...)`:
   - The live list is diffed against the committed **baseline snapshot**.
   - Identity changes are excluded from the canonical set.
   - Optionally, **every Stock Token is verified onchain** in one multicall: `uid()`, `symbol()`, `decimals()` and `ACCESS_CONTROLLED_REGISTRY()` = beacon `0xe10b…1b00`.
   - A mismatch → `CONFLICT`, non-canonical, `REGISTRY_CONFLICT` warning.
   - An RPC failure during verification is *not* treated as a mismatch.

## Change detection (`diff.ts`)

| Change | Identity? | Effect |
|---|---|---|
| ADDED (new uid at a new address) | no | accepted (official list), reported |
| REMOVED / no longer ACTIVE | no | no longer scanned, reported |
| MULTIPLIER_CHANGED, PENDING_MULTIPLIER_CHANGED | no | reported (the onchain multiplier is used anyway) |
| METADATA_CHANGED (name, symbol on the same token, isin, logo) | no | reported |
| **ADDRESS_CHANGED** (same uid, new address) | **yes** | new address NOT canonical until reviewed |
| **UID_CHANGED** (same address, new uid) | **yes** | not canonical until reviewed |
| **SYMBOL_REASSIGNED** (a ticker now names another contract) | **yes** | not canonical until reviewed |
| **DECIMALS_CHANGED** | **yes** | not canonical until reviewed |

A changed contract address is never trusted automatically.

## Snapshot (`snapshot.ts`, file `packages/robinhood/data/registry/robinhood-stock-tokens.snapshot.json`)
- Fields: `schemaVersion`, `source`, `chainId`, `generatedAt`, `sourceFetchedAt`, `assetCount`, `contentHash` (sha256 over canonical JSON, independent of order and address case), `entries`.
- `parseSnapshot` rejects a wrong chain, a count mismatch, or a **hash mismatch** (a hand-edited file).
- Uses: the **baseline** for change detection, **degraded mode** when the API is down, and test fixtures.
- In degraded mode the registry reports `mode: "SNAPSHOT"`, `dataAsOf` = the snapshot's source fetch time, and freshness per `ASSET_REGISTRY` policy (FRESH ≤ 15 min, AGING ≤ 24 h, else STALE). The portfolio shows `REGISTRY_SNAPSHOT_MODE` and, when old, `REGISTRY_STALE`. A snapshot is never presented as live.
- Refresh:
  - `pnpm registry:snapshot` writes only if there are no identity changes.
  - `--accept-identity-changes` is for after a human has reviewed them.
  - `pnpm registry:check` exits non-zero on identity changes (suitable for CI).

Current baseline (2026-09-24): 195 entries, `sha256:c316dd53e1a1e70ede17d0d9732ea19171e8b161e399966174d18141e6f5776c`. Live check: 195/195 onchain identity matches, 0 changes vs the snapshot.

## Crypto tokens (`CRYPTO_ASSETS`, `packages/robinhood/src/config/assets.ts`)

Besides ETH, WETH, USDG and the Stock Tokens, a crypto token is canonical only if it passes all of these (checked 2026-10-01):
- **Chainlink feed:** a `<SYMBOL> / USD` feed for it exists in the Chainlink directory for Robinhood Chain mainnet and answers fresh. This is also how the token is priced.
- **Two independent lists:** CoinGecko's Robinhood token list (`tokens.coingecko.com/robinhood/all.json`) and LI.FI's token list for chain 4663 give the same address.
- **Onchain:** `symbol()`, `name()` and `decimals()` match, and the contract has code.

Admitted: cbBTC, USDe.

LINK passes every check but is left out: it has no pool or market on Robinhood Chain yet.

Not yet admitted:
- ENA, weETH, wstETH: they have a feed but only one list names their address.
- sUSDe, syrupUSDC, syrupUSDG: exchange-rate feeds only.
- Everything else on the chain (meme tokens).

## Yield-bearing USDG tokens (`USDG_RATE_ASSETS`)

These are crypto tokens worth a rate in USDG. They are priced at that rate × Chainlink USDG/USD (`USDG_RATE`).

| Token | Where it is used | Rate source |
|---|---|---|
| syrupUSDG (Maple) | Morpho collateral, ~$14.6M | Chainlink "syrupUSDG / USDG Exchange Rate"; address named by CoinGecko's and LI.FI's lists |
| spUSDG (Spark Savings) | Spark vault, Morpho collateral, ~$14.1M | ERC-4626 `convertToAssets(1 share)`, read onchain; `asset()` is USDG |

Selection: tokens that actually have earn, LP or borrow markets. They were found by scanning every protocol adapter for non-canonical assets (2026-10-01).

Look-alikes are never admitted. Morpho markets use tokens named "USDe", "USDG", "WETH" and "ETH" at other addresses.

mGLO (~$3.1M on Morpho) is pending. It needs Midas' own oracle.
