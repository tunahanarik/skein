/**
 * Pendle adapter. Read-only.
 *
 * Discovery is ONCHAIN: CreateNewMarket logs of the official marketFactoryV6, so markets the
 * Pendle app does not list are found too (e.g. the USDG market, 2026-09-24). No market list is
 * hardcoded. Every market is then verified structurally (isValidMarket, isPT/isYT, PT↔YT↔SY links).
 *
 * Caches (separate, per docs/protocols/pendle-adapter.md):
 *   market list  discovered markets + last scanned block; TTL PROTOCOL_MARKET_LIST; refreshed
 *                incrementally from the last scanned block
 *   config       per-market onchain identity; TTL PROTOCOL_MARKET_CONFIG
 *   api state    per-market Pendle API response; TTL PROTOCOL_MARKET_STATE; on refresh failure the
 *                last good copy is served for up to PROTOCOL_STATE_STALE_FALLBACK (marked stale)
 * Pool state, SY rate and RouterStatic rates are read onchain at the context block every run.
 * Failures are never cached.
 */
import type { Address } from "viem";
import { CACHE_TTL_MS, classifyFreshness } from "@skein/core/config/freshness";
import { TtlCache } from "@skein/core/lib/cache";
import { HttpError, type HttpClient } from "@skein/core/lib/http";
import { mulDivDown, WAD } from "@skein/core/lib/fixed";
import { formatFixed, usdValueE18, USD_DECIMALS } from "@skein/core/lib/units";
import type { AssetRef, Opportunity, OpportunityCategory } from "@skein/core/model/opportunity";
import type { Position } from "@skein/core/model/position";
import type { DataSource } from "@skein/core/model/provenance";
import { warn, type Warning } from "@skein/core/model/warnings";
import type { AdapterCapabilities, AdapterContext, AdapterIssue, AdapterResult, OpportunityAdapter, ResultStatus } from "@skein/engine/opportunities/adapter";
import { priceCanonicalAssets } from "@skein/engine/opportunities/assetPricing";
import { assetKey } from "@skein/robinhood/registry/asset";
import { sanitizeSymbol } from "@skein/core/lib/sanitize";
import { PendleApiClient, type PendleApi, type PendleApiResult } from "./api.js";
import { PENDLE_CONTRACTS } from "./constants.js";
import { normalizePendleMarket, PROTOCOL, VENUE_KIND, type PendleNormalizeContext } from "./normalize.js";
import { discoverMarkets, readBalances, readIdentities, readStates, type DiscoveredMarket, type MarketIdentity, type MarketState } from "./onchain.js";

/** Parallel Pendle API requests per run (one request per market; the API has no batch endpoint with dataUpdatedAt). */
export const PENDLE_API_CONCURRENCY = 4;

interface ApiLoad {
  result: PendleApiResult | null;
  error: string | null;
  stale: boolean;
  notIndexed: boolean;
  skipped: boolean;
}

interface MarketList {
  markets: DiscoveredMarket[];
  scannedTo: bigint;
  storedAt: number;
}

interface Snapshot {
  opportunities: Opportunity[];
  warnings: Warning[];
  issues: AdapterIssue[];
  status: ResultStatus;
  timingsMs: Record<string, number>;
  identities: MarketIdentity[];
  states: Map<string, MarketState>;
  normalizeCtx: PendleNormalizeContext;
}

const ms = (t: number) => Math.round(performance.now() - t);

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

export interface PendleAdapterOptions {
  api?: PendleApi;
  now?: () => number;
  /** First block scanned for CreateNewMarket (default 0: the factory's logs are sparse). */
  fromBlock?: bigint;
}

export class PendleAdapter implements OpportunityAdapter {
  readonly protocol = { ...PROTOCOL };
  readonly categories: readonly OpportunityCategory[] = ["FIXED_YIELD", "YIELD", "LP"];
  readonly capabilities: AdapterCapabilities = { discovery: true, assetFiltering: false, userPositions: true, singleOpportunity: true, execution: false };

  private readonly api: PendleApi;
  private readonly clock: () => number;
  private readonly fromBlock: bigint;
  private list: MarketList | null = null;
  private listInflight: Promise<MarketList> | null = null;
  private readonly identityCache = new Map<string, { identity: MarketIdentity; block: { number: bigint; timestamp: bigint }; storedAt: number }>();
  private readonly apiCache: TtlCache<PendleApiResult>;
  /** 404 answers ("not indexed") are an answer, not a failure: remembered for the state TTL. */
  private readonly notIndexedCache: TtlCache<true>;

  constructor(http: HttpClient, opts: PendleAdapterOptions = {}) {
    this.api = opts.api ?? new PendleApiClient(http);
    this.clock = opts.now ?? (() => Date.now());
    this.fromBlock = opts.fromBlock ?? 0n;
    this.apiCache = new TtlCache<PendleApiResult>(this.clock);
    this.notIndexedCache = new TtlCache<true>(this.clock);
  }

  supportsCategory(c: OpportunityCategory): boolean {
    return this.categories.includes(c);
  }

  /** Market list, extended incrementally; stale list served (degraded) if a rescan fails. */
  private async loadMarkets(ctx: AdapterContext, issues: AdapterIssue[], warnings: Warning[]): Promise<DiscoveredMarket[]> {
    const cur = this.list;
    if (cur && this.clock() - cur.storedAt < CACHE_TTL_MS.PROTOCOL_MARKET_LIST) return cur.markets;
    try {
      this.listInflight ??= (async () => {
        const from = cur ? cur.scannedTo + 1n : this.fromBlock;
        const found = await discoverMarkets(ctx.reader, from, ctx.blockNumber);
        const seen = new Map((cur?.markets ?? []).map((m) => [m.market.toLowerCase(), m]));
        for (const f of found) if (!seen.has(f.market.toLowerCase())) seen.set(f.market.toLowerCase(), f);
        const next: MarketList = { markets: [...seen.values()], scannedTo: ctx.blockNumber > (cur?.scannedTo ?? -1n) ? ctx.blockNumber : cur!.scannedTo, storedAt: this.clock() };
        this.list = next;
        return next;
      })().finally(() => {
        this.listInflight = null;
      });
      return (await this.listInflight).markets;
    } catch (e) {
      if (cur && this.clock() - cur.storedAt <= CACHE_TTL_MS.PROTOCOL_STATE_STALE_FALLBACK) {
        issues.push({ scope: "pendle:discovery", message: `market rescan failed (${(e as Error).message.split("\n")[0]}); using list scanned to block ${cur.scannedTo}`, severity: "DEGRADED" });
        warnings.push(warn("MARKET_DISCOVERY_DEGRADED", `Pendle market discovery failed; using the list scanned to block ${cur.scannedTo} (${Math.round((this.clock() - cur.storedAt) / 1000)}s old)`));
        return cur.markets;
      }
      throw e;
    }
  }

  private async loadApi(market: Address, expiry: bigint | null, ctx: AdapterContext): Promise<ApiLoad> {
    const key = market.toLowerCase();
    // Expired markets publish no yields; the API adds nothing we use for them.
    if (expiry !== null && expiry <= ctx.blockTimestamp) return { result: null, error: null, stale: false, notIndexed: false, skipped: true };
    const notIndexed: ApiLoad = { result: null, error: "not indexed by the Pendle API (HTTP 404)", stale: false, notIndexed: true, skipped: false };
    if (this.notIndexedCache.get(key)) return notIndexed;
    try {
      return { result: await this.apiCache.getOrLoad(key, CACHE_TTL_MS.PROTOCOL_MARKET_STATE, () => this.api.market(ctx.chainId, market)), error: null, stale: false, notIndexed: false, skipped: false };
    } catch (e) {
      // 404: the Pendle API does not index this market (e.g. unlisted/test markets). Expected, not a failure.
      if (e instanceof HttpError && e.status === 404) {
        this.notIndexedCache.set(key, true, CACHE_TTL_MS.PROTOCOL_MARKET_STATE);
        return notIndexed;
      }
      const msg = (e as Error).message.split("\n")[0] ?? "failed";
      const stale = this.apiCache.getStale(key);
      if (stale && this.clock() - stale.storedAt <= CACHE_TTL_MS.PROTOCOL_STATE_STALE_FALLBACK) return { result: stale.value, error: msg, stale: true, notIndexed: false, skipped: false };
      return { result: null, error: msg, stale: false, notIndexed: false, skipped: false };
    }
  }

  private async snapshot(ctx: AdapterContext): Promise<Snapshot> {
    const timingsMs: Record<string, number> = {};
    const issues: AdapterIssue[] = [];
    const warnings: Warning[] = [];
    const nowS = Math.floor(ctx.now().getTime() / 1000);
    const generatedAt = ctx.now().toISOString();

    let t = performance.now();
    const discovered = await this.loadMarkets(ctx, issues, warnings);
    timingsMs.discovery = ms(t);

    // ---- identity (cached config) ----
    t = performance.now();
    const now = this.clock();
    const need = discovered.filter((d) => {
      const c = this.identityCache.get(d.market.toLowerCase());
      return !c || now - c.storedAt >= CACHE_TTL_MS.PROTOCOL_MARKET_CONFIG;
    });
    if (need.length) {
      const read = await readIdentities(ctx.reader, need.map((d) => d.market), ctx.blockNumber);
      for (const d of need) {
        const r = read.get(d.market.toLowerCase());
        if (!r || "error" in r) {
          issues.push({ scope: `pendle market ${d.market.slice(0, 10)}…`, message: r ? r.error : "identity not read", severity: "DEGRADED" });
          continue;
        }
        // Cache only markets whose basic identity was readable; failures are retried next run.
        if (r.expiry !== null && r.sy_.decimals !== null) this.identityCache.set(d.market.toLowerCase(), { identity: r, block: { number: ctx.blockNumber, timestamp: ctx.blockTimestamp }, storedAt: now });
        else issues.push({ scope: `pendle market ${d.market.slice(0, 10)}…`, message: "identity partly unreadable; not cached", severity: "DEGRADED" });
      }
    }
    const withId = discovered.map((d) => ({ d, c: this.identityCache.get(d.market.toLowerCase()) })).filter((x): x is { d: DiscoveredMarket; c: NonNullable<typeof x.c> } => !!x.c);
    const identities = withId.map((x) => x.c.identity);
    timingsMs.identity = ms(t);

    // ---- onchain state + API state in parallel ----
    t = performance.now();
    const [states, apis] = await Promise.all([
      readStates(ctx.reader, identities, ctx.blockNumber),
      mapLimit(identities, PENDLE_API_CONCURRENCY, (i) => this.loadApi(i.market, i.expiry, ctx)),
    ]);
    timingsMs.stateAndApi = ms(t);
    identities.forEach((i, n) => {
      const a = apis[n]!;
      if (a.error && !a.notIndexed) issues.push({ scope: `pendle-api ${i.market.slice(0, 10)}…`, message: a.stale ? `refresh failed (${a.error}); serving cached state` : a.error, severity: "DEGRADED" });
      const s = states.get(i.market.toLowerCase());
      if (s?.errors.length) issues.push({ scope: `pendle market ${i.market.slice(0, 10)}…`, message: `state reads failed: ${s.errors.join("; ").slice(0, 300)}`, severity: "DEGRADED" });
    });

    // ---- prices (Phase 1 Price Service only) ----
    t = performance.now();
    const keys = new Set<string>();
    for (const i of identities) for (const a of [i.yieldToken?.address, ...i.tokensIn.map((x) => x.address)]) if (a) keys.add(assetKey(ctx.chainId, a));
    const priced = await priceCanonicalAssets(ctx, keys);
    timingsMs.prices = ms(t);

    const normalizeCtx: PendleNormalizeContext = {
      chainId: ctx.chainId,
      blockNumber: ctx.blockNumber,
      blockTimestamp: ctx.blockTimestamp,
      nowS,
      generatedAt,
      resolveAsset: (address, symbol, decimals): AssetRef => {
        const a = ctx.registry.get(ctx.chainId, address);
        if (a && a.canonical) return { key: a.key, chainId: ctx.chainId, address, symbol: a.symbol, decimals: a.decimals, canonical: true, registryType: a.type };
        return { key: assetKey(ctx.chainId, address), chainId: ctx.chainId, address, symbol: sanitizeSymbol(symbol, 16) || "?", decimals: decimals ?? 18, canonical: false, registryType: null };
      },
      priceOf: priced.priceOf,
      isLookalike: (ref) => !ref.canonical && ctx.registry.canonicalBySymbol(ref.symbol).length > 0,
    };

    // ---- normalize, isolating each market ----
    t = performance.now();
    const opportunities: Opportunity[] = [];
    let failed = 0;
    withId.forEach(({ d, c }, n) => {
      try {
        const a = apis[n]!;
        const r = normalizePendleMarket({ discovered: d, identity: c.identity, identityBlock: c.block, state: states.get(c.identity.market.toLowerCase()) ?? null, api: a.result, apiError: a.error, apiStale: a.stale, apiSkipped: a.skipped, apiNotIndexed: a.notIndexed }, normalizeCtx);
        opportunities.push(...r.opportunities);
        if (!r.opportunities.length) warnings.push(...r.warnings);
      } catch (e) {
        failed++;
        issues.push({ scope: `pendle market ${d.market.slice(0, 10)}…`, message: (e as Error).message, severity: "FATAL" });
      }
    });
    timingsMs.normalize = ms(t);
    const status: ResultStatus = discovered.length === 0 ? "COMPLETE" : issues.length || failed ? "PARTIAL" : "COMPLETE";
    return { opportunities, warnings, issues, status, timingsMs, identities, states, normalizeCtx };
  }

  async getOpportunities(ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>> {
    const s = await this.snapshot(ctx);
    return { data: s.opportunities, status: s.status, issues: s.issues, warnings: s.warnings, timingsMs: s.timingsMs };
  }

  async getOpportunity(id: string, ctx: AdapterContext): Promise<AdapterResult<Opportunity | null>> {
    const s = await this.snapshot(ctx);
    return { data: s.opportunities.find((o) => o.id === id.toLowerCase() || o.id === id) ?? null, status: s.status, issues: s.issues, warnings: [], timingsMs: s.timingsMs };
  }

  /**
   * PT, YT and LP balances read onchain in every discovered market (expired ones included:
   * matured PT stays redeemable). Values use RouterStatic rates → SY → yield token, priced by
   * the Price Service. Unclaimed YT interest and LP/PENDLE rewards are NOT included.
   * The wallet address is never sent to the Pendle API.
   */
  async getUserPositions(wallet: Address, ctx: AdapterContext): Promise<AdapterResult<Position[]>> {
    const s = await this.snapshot(ctx);
    const t = performance.now();
    const balances = await readBalances(ctx.reader, s.identities, wallet, ctx.blockNumber);
    const n = s.normalizeCtx;
    const issues: AdapterIssue[] = [...s.issues];
    const out: Position[] = [];
    const blockFresh = classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), n.nowS);
    const obs = new Date(Number(ctx.blockTimestamp) * 1000).toISOString();
    const src = (method: string, contract: Address): DataSource => ({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: ctx.blockNumber, observedAt: n.generatedAt });
    let unreadable = 0;
    for (const i of s.identities) {
      const b = balances.get(i.market.toLowerCase());
      const st = s.states.get(i.market.toLowerCase());
      if (!b || !i.yieldToken || i.sy_.decimals === null || i.expiry === null) continue;
      const yieldToken = n.resolveAsset(i.yieldToken.address, i.yieldToken.symbol, i.yieldToken.decimals);
      const price = n.priceOf(yieldToken.key).price;
      const expired = ctx.blockTimestamp >= i.expiry;
      const toToken = (bal: bigint, rate: bigint | null | undefined): bigint | null => {
        if (rate == null || !st?.syExchangeRate || st.yieldTokenPerSy === null) return null;
        const accounting = mulDivDown(bal, rate, WAD);
        const syUnits = mulDivDown(accounting, WAD, st.syExchangeRate);
        return mulDivDown(syUnits, st.yieldTokenPerSy, 10n ** BigInt(i.sy_.decimals!));
      };
      const legs: { kind: Position["kind"]; bal: bigint | null; rate: bigint | null | undefined; token: Address; rateFn: string; cat: OpportunityCategory; sym: string }[] = [
        { kind: "PRINCIPAL_TOKEN", bal: b.pt, rate: st?.ptToAssetRate, token: i.pt, rateFn: "getPtToAssetRate", cat: "FIXED_YIELD", sym: sanitizeSymbol(i.pt_.symbol) || "PT" },
        { kind: "YIELD_TOKEN", bal: b.yt, rate: st?.ytToAssetRate, token: i.yt, rateFn: "getYtToAssetRate", cat: "YIELD", sym: sanitizeSymbol(i.yt_.symbol) || "YT" },
        { kind: "LIQUIDITY_POOL", bal: b.lp, rate: st?.lpToAssetRate, token: i.market, rateFn: "getLpToAssetRate", cat: "LP", sym: "LP" },
      ];
      for (const leg of legs) {
        if (leg.bal === null) {
          unreadable++;
          continue;
        }
        if (leg.bal === 0n) continue;
        const tokRaw = toToken(leg.bal, leg.rate);
        const warnings: Warning[] = [warn("REWARDS_MAY_BE_INCOMPLETE", "unclaimed YT interest and LP/PENDLE rewards are not included in this value")];
        if (tokRaw === null) warnings.push(warn("POSITION_UNVERIFIED", `Pendle ${leg.sym}: rate unreadable; value not computed`));
        const usd = tokRaw !== null && price ? usdValueE18(tokRaw, yieldToken.decimals, price.raw, price.decimals) : null;
        const decimals = leg.kind === "LIQUIDITY_POOL" ? (i.lpDecimals ?? 18) : (i.sy_.decimals ?? 18);
        const posToken: AssetRef = { key: assetKey(ctx.chainId, leg.token), chainId: ctx.chainId, address: leg.token, symbol: leg.sym, decimals, canonical: false, registryType: null };
        const rateSrc = src(`RouterStatic.${leg.rateFn}(market) → SY.exchangeRate → SY.previewRedeem`, PENDLE_CONTRACTS.routerStatic);
        out.push({
          id: `${ctx.chainId}:${PROTOCOL.id}:position:${leg.kind.toLowerCase()}:${i.market.toLowerCase()}`,
          chainId: ctx.chainId,
          protocol: { ...PROTOCOL },
          kind: leg.kind,
          venue: { kind: VENUE_KIND, id: i.market.toLowerCase(), address: i.market },
          relatedOpportunityIds: [`${ctx.chainId}:${PROTOCOL.id}:${leg.cat}:${VENUE_KIND}:${i.market.toLowerCase()}`],
          assets: [posToken, yieldToken],
          supplied:
            tokRaw === null
              ? null
              : {
                  value: { asset: yieldToken, amount: { raw: tokRaw, decimals: yieldToken.decimals, display: formatFixed(tokRaw, yieldToken.decimals) }, usd: usd === null ? null : { e18: usd, display: formatFixed(usd, USD_DECIMALS) } },
                  origin: "COMPUTED",
                  source: rateSrc,
                  observedAt: obs,
                  freshness: blockFresh,
                  verification: "VERIFIED_ONCHAIN",
                  formula: "balance × rate / 1e18 (accounting units) × 1e18 / SY.exchangeRate × SY.previewRedeem(yieldToken, 1 SY) — spot value, before exit fees/slippage",
                },
          borrowed: null,
          collateral: null,
          shares: { value: leg.bal, origin: "SUPPLIED", source: src("balanceOf(user)", leg.token), observedAt: obs, freshness: blockFresh, verification: "VERIFIED_ONCHAIN" },
          healthFactor: null,
          ltv: null,
          liquidatable: null,
          provenance: [src("balanceOf(user)", leg.token), rateSrc],
          conflicts: [],
          warnings,
          freshness: blockFresh,
          verificationStatus: i.checks.every((c) => c.ok === true) && yieldToken.canonical ? "VERIFIED_ONCHAIN" : "UNVERIFIED",
          maturity: { at: new Date(Number(i.expiry) * 1000).toISOString(), expired },
        });
      }
    }
    if (unreadable) issues.push({ scope: "positions", message: `${unreadable} Pendle balances unreadable`, severity: "DEGRADED" });
    return { data: out, status: unreadable ? "PARTIAL" : s.status, issues, warnings: [], timingsMs: { ...s.timingsMs, positions: ms(t) } };
  }
}
