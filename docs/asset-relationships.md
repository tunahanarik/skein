# Asset relationships

`src/model/assetRelationship.ts`. This is a generic, provenance-carrying graph between tokens. It is not Pendle-specific: the same kinds describe vault shares, LP tokens and receipt tokens. Each opportunity carries the relationships that explain its assets (`Opportunity.relationships`).

```ts
interface AssetRelationship {
  kind: "WRAPS" | "REPRESENTS_CLAIM_ON" | "PRINCIPAL_COMPONENT_OF" | "YIELD_COMPONENT_OF" | "LP_SHARE_OF" | "DERIVED_FROM";
  from: AssetRef; to: AssetRef;
  terms: string | null;          // conditions in plain words
  source: DataSource;            // where the link was read (onchain call + block)
  verification: VerificationStatus;
}
```

| Kind | Meaning | Pendle example | Evidence |
|---|---|---|---|
| WRAPS | `from` is a wrapper holding `to` | SY-NVDA wraps NVDA | `SY.yieldToken()`; terms quote `SY.previewRedeem(yieldToken, 1 SY)` |
| PRINCIPAL_COMPONENT_OF | `from` is the principal part split from `to` | PT of SY | `PT.SY()` + `yieldContractFactory.isPT(PT)` |
| YIELD_COMPONENT_OF | `from` is the yield part split from `to` | YT of SY | `YT.SY()` + `isYT(YT)` |
| REPRESENTS_CLAIM_ON | `from` redeems for `to` under stated conditions | PT → accounting asset (1 unit at maturity; watermark caveat; share units for Stock Tokens) | `SY.assetInfo()` |
| LP_SHARE_OF | `from` is a share of a pool holding `to` | LP of PT, LP of SY | `market.readTokens()` |
| DERIVED_FROM | any other verified derivation | — | — |

Rules:
- **Identity is by address only.** Symbols from contracts or APIs are display-only and pass through `sanitizeSymbol`.
- **Verification.**
  - A relationship is `VERIFIED_ONCHAIN` only when every structural check behind it passed.
  - A broken link (for example `PT.SY()` ≠ the market's SY) makes it `UNVERIFIED`, and the opportunity becomes UNVERIFIED too.
- **Canonical resolution.** `resolveToCanonical(start, edges)` follows WRAPS and *_COMPONENT_OF edges to the first **canonical** registry asset, with bounded depth. Example: PT-NVDA → SY-NVDA → NVDA (canonical).
  - An opportunity whose protocol tokens do not resolve to a canonical asset has `risk.allAssetsCanonical = false`. It is excluded by default as `UNVERIFIED_ASSET`.
- **Protocol-issued tokens are never `canonical`.** PT, YT, SY and LP are not in the Robinhood registry. They are trusted only through factory checks plus a verified path to a canonical asset.
- **Registry identity changes still require manual review** (Phase 1 rule, unchanged). The relationship graph is rebuilt from chain reads; it never edits the registry.

Morpho opportunities currently carry `relationships: []`. Morpho Blue markets hold canonical assets directly. Vault shares could later be modelled as `WRAPS` of the vault asset without changing the model.
