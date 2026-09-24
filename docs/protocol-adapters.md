# Protocol adapters

`src/opportunities/adapter.ts`. Each protocol is one class implementing `OpportunityAdapter`. The engine consumes only this interface.

```ts
interface OpportunityAdapter {
  protocol: { id; name };
  categories: readonly OpportunityCategory[];
  capabilities: { discovery; assetFiltering; userPositions; singleOpportunity; execution: false };
  supportsCategory(c): boolean;
  getOpportunities?(ctx): Promise<AdapterResult<Opportunity[]>>;
  getAssetOpportunities?(assetKey, ctx): Promise<AdapterResult<Opportunity[]>>;
  getOpportunity?(id, ctx): Promise<AdapterResult<Opportunity | null>>;
  getUserPositions?(wallet, ctx): Promise<AdapterResult<Position[]>>;
}
```

- **Capabilities are declared, not probed.** For example, if `assetFiltering` is false the engine filters discovery output itself. Unsupported methods are simply absent, and `execution` is the literal type `false`.
- **Context:** `AdapterContext` = chainId, `ChainReader` (read-only), `AssetRegistry`, `PriceService`, clock, and **one pinned block**.
- **Results:** `AdapterResult<T>` = `data` + `status` (COMPLETE / PARTIAL / UNKNOWN) + `issues` (DEGRADED or FATAL, scoped) + typed `warnings` + `timingsMs`. Adapters report data gaps instead of throwing. A throw is caught by the engine and turned into UNKNOWN.

## Rules every adapter must follow
1. **Assets by address.** Resolve every token through `registry.get(chainId, address)`. A non-canonical token gets `canonical: false`, `NON_CANONICAL_ASSET` (or `LOOKALIKE_TOKEN` when its symbol matches a canonical asset), and verification `UNVERIFIED`.
2. **No self-pricing.** USD values come from `ctx.prices` (Phase 1). Protocol-reported USD floats and protocol oracles are never used for valuation.
3. **Explicit yield types** (see opportunity-engine.md). Never emit an untyped "apy".
4. **Provenance on every value.** Use `Measured<T>` with `source.type` / `provider` / `method` / `url` or `contract` / `blockNumber` / `sourceTimestamp`, and `origin` SUPPLIED or COMPUTED.
5. **Freshness from `src/config/freshness.ts` only.** Adapters must not hardcode ages or TTLs.
6. **Cross-verify against the chain** where the chain is authoritative. On disagreement, emit a `DataConflict` with both values, keep the authoritative one, and say so in `resolution`.
7. **Separate caches:** slow configuration and fast state, using `CACHE_TTL_MS`. Never cache failures; stale fallback must be bounded and reported.
8. **Positions are not opportunities.**
9. **Read-only.** No approvals, signatures, transaction building or submission.
10. **(Phase 3) Describe facts; the engine applies policy.** Set:
    - `lifecycle` (use `openEndedLifecycle` / `maturityLifecycle`, with blockers such as DEPOSIT_DISABLED or PROTOCOL_PAUSED)
    - `entry` (an `EntryRequirement` with verified steps; UNKNOWN when there is no evidence)
    - `liquidityKind`
    - `relationships`

    Leave `eligibility: null`: the engine computes it.
11. **(Phase 3) Only advertise implemented capabilities.** Pendle declares `userPositions: true` because balances and rates are fully interpretable onchain.
12. **(Phase 3) Sanitize token metadata.** Chain-read symbols go through `sanitizeSymbol` (`src/lib/sanitize.ts`), and API strings through `sanitizeLabel`.

## Adding a protocol
1. Create `src/protocols/<name>/` with API/onchain readers, a pure `normalize.ts`, and `adapter.ts`.
2. Map venues to categories and set lifecycle, entry, liquidity kind and relationships.
3. Add a `details` member to `OpportunityDetails`.
4. Register it in `src/runtime.ts`.
5. **No protocol-specific change to the engine.**

Phase 3 did exactly this for Pendle ([protocols/pendle-adapter.md](protocols/pendle-adapter.md)).

**Assumptions from Phase 2 that changed, and why:**
- **PT `denominatedIn`.** Phase 2 planned `denominatedIn` = the underlying. It is now the accounting asset only when the SY asset type is TOKEN, and `null` for Stock Token markets, where the accounting unit is a *share* (SY.exchangeRate == uiMultiplier, measured). Claiming token units would be wrong.
- **PT withdrawal.** Phase 2 planned `withdrawal: AT_MATURITY`. It is now `TRADE_BEFORE_MATURITY`: Pendle positions can be sold at market price before maturity, while redemption at par happens at maturity. Maturity is modelled in `lifecycle`, separately from exit.
- **Engine changes.** Phase 3 added *generic* engine features (eligibility, lifecycle/maturity filters, MATURITY sort), not Pendle logic.
