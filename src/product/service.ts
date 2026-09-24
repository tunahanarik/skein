/**
 * AssetIntelligenceService — the product read API boundary (docs/asset-intelligence.md).
 * A future HTTP route can call these methods directly. Read-only; nothing here quotes a whole
 * balance, persists a wallet address or sends one to a protocol API.
 *
 *   getAssetIntelligence(asset, opts)      one asset, PRODUCT or DEBUG mode, optional trade target/amount
 *   getCategory(asset, category, opts)     one product category of that view
 *   getPortfolioIntelligence(wallet, opts) every held canonical asset
 *   getCoverage()                          machine-readable coverage matrix for all canonical assets
 *   getRawOpportunities(query)             RAW mode: the engine's untouched output
 */
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { CACHE_TTL_MS } from "../config/freshness.js";
import { PRODUCT_MAX_ROUTES_PER_TARGET, PRODUCT_TRADE_TARGET_KEYS, QUOTE_CONCURRENCY } from "../config/trade.js";
import { TtlCache } from "../lib/cache.js";
import { formatFixed, USD_DECIMALS } from "../lib/units.js";
import type { AssetRef, Opportunity } from "../model/opportunity.js";
import type { TradeMarket, TradeRoute } from "../model/trade.js";
import { isAuthoritative } from "../model/verification.js";
import type { AdapterContext } from "../opportunities/adapter.js";
import { priceCanonicalAssets } from "../opportunities/assetPricing.js";
import type { EngineResult, OpportunityEngine, OpportunityQuery } from "../opportunities/engine.js";
import type { Portfolio, PortfolioAsset } from "../portfolio/types.js";
import type { AssetRegistry } from "../registry/registry.js";
import { buildTradeGraph, destinations, findRoutes, type TradeGraph } from "../trade/graph.js";
import { opportunityCard, routeCard } from "./cards.js";
import { PRODUCT_CATEGORY_ORDER, SUBCATEGORY_ORDER, productCategoryOf } from "./categories.js";
import { Metrics } from "./metrics.js";
import { criticalValues, summarizeDataQuality, summarizeFreshness, type AdapterStatus, type TimedValue } from "./quality.js";
import { rankCards } from "./ranking.js";
import type {
  AssetIntelligence,
  BalanceView,
  Capabilities,
  CategoryView,
  CoverageRow,
  DataQuality,
  EmptyState,
  OpportunityCounts,
  PortfolioIntelligence,
  PriceView,
  ProductCard,
  ProductCategory,
  ProductMode,
  UsabilityResult,
} from "./types.js";
import { classifyOpportunity, classifyQuotedRoute, classifyRoute, DEFAULT_VISIBLE } from "./usability.js";

export interface IntelligenceDeps {
  engine: OpportunityEngine;
  getPortfolio: (wallet: string) => Promise<Portfolio>;
  now?: () => Date;
  metrics?: Metrics;
  /**
   * Stale-while-revalidate window for the engine snapshot (server mode). Within it, an expired
   * snapshot is served while a refresh runs in the background. Freshness stays honest: every age
   * is evaluated at response time from the data's own timestamps. Default 0 (CLIs, tests).
   */
  maxStaleMs?: number;
}

export interface AssetQueryOptions {
  mode?: ProductMode;
  /** Registry key or address of an explicit trade target. */
  tradeTarget?: string;
  /** Decimal amount of the asset to quote (requires tradeTarget). Never inferred from a balance. */
  tradeAmount?: string;
  /** The holder's row (portfolio view); enables balance and borrow capacity. */
  holding?: PortfolioAsset | null;
}

interface Snapshot {
  ctx: AdapterContext;
  all: EngineResult<Opportunity[]>;
  byPrimary: Map<string, Opportunity[]>;
  graph: TradeGraph;
  markets: Map<string, TradeMarket>;
  /** `${marketId}|${inputKey}` → raw TRADE opportunity id (one per market direction). */
  hopOpportunities: Map<string, string>;
  takenAt: number;
}

const ms = (t: number) => performance.now() - t;

/** Order-preserving map with at most `limit` promises in flight. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const usd = (e18: bigint) => ({ e18, display: formatFixed(e18, USD_DECIMALS) });

function emptyCounts(): OpportunityCounts {
  return { discovered: 0, verified: 0, actionable: 0, limited: 0, informational: 0, hidden: 0, unavailable: 0, hiddenByReason: {} };
}

function addCount(c: OpportunityCounts, o: Opportunity, u: UsabilityResult): void {
  c.discovered++;
  if (isAuthoritative(o.verificationStatus)) c.verified++;
  if (u.status === "ACTIONABLE") c.actionable++;
  else if (u.status === "LIMITED") c.limited++;
  else if (u.status === "INFORMATIONAL") c.informational++;
  else {
    if (u.status === "HIDDEN_BY_DEFAULT") c.hidden++;
    else c.unavailable++;
    for (const r of u.reasons) c.hiddenByReason[r] = (c.hiddenByReason[r] ?? 0) + 1;
  }
}

function mergeCounts(a: OpportunityCounts, b: OpportunityCounts): OpportunityCounts {
  const out = { ...a, hiddenByReason: { ...a.hiddenByReason } };
  for (const k of ["discovered", "verified", "actionable", "limited", "informational", "hidden", "unavailable"] as const) out[k] += b[k];
  for (const [r, n] of Object.entries(b.hiddenByReason)) out.hiddenByReason[r as keyof OpportunityCounts["hiddenByReason"]] = (out.hiddenByReason[r as keyof OpportunityCounts["hiddenByReason"]] ?? 0) + (n ?? 0);
  return out;
}

function capabilitiesOf(cards: readonly { category: ProductCategory; usability: UsabilityResult }[]): Capabilities {
  const detail = {} as Capabilities["detail"];
  for (const cat of PRODUCT_CATEGORY_ORDER) {
    const cs = cards.filter((c) => c.category === cat);
    const has = (u: UsabilityResult["status"]) => cs.some((c) => c.usability.status === u);
    detail[cat] = has("ACTIONABLE") ? "ACTIONABLE" : has("LIMITED") ? "LIMITED_ONLY" : has("INFORMATIONAL") ? "INFORMATIONAL_ONLY" : "NONE";
  }
  return { canTrade: detail.TRADE === "ACTIONABLE", canEarn: detail.EARN === "ACTIONABLE", canBorrowAgainst: detail.BORROW === "ACTIONABLE", canProvideLiquidity: detail.LIQUIDITY === "ACTIONABLE", detail };
}

export class AssetIntelligenceService {
  readonly metrics: Metrics;
  private readonly now: () => Date;
  private readonly snapCache: TtlCache<Snapshot>;
  private readonly viewCache: TtlCache<AssetIntelligence>;

  constructor(private readonly deps: IntelligenceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.metrics = deps.metrics ?? new Metrics();
    this.snapCache = new TtlCache<Snapshot>(() => this.now().getTime());
    this.viewCache = new TtlCache<AssetIntelligence>(() => this.now().getTime());
  }

  // ---------------------------------------------------------------- snapshot (shared by everything)

  private async snapshot(): Promise<Snapshot> {
    if (this.snapCache.get("snap")) this.metrics.inc("cache_hit", 1, { cache: "snapshot" });
    else {
      const stale = this.snapCache.getStale("snap");
      if (stale && this.now().getTime() - stale.storedAt < CACHE_TTL_MS.PRODUCT_SNAPSHOT + (this.deps.maxStaleMs ?? 0)) {
        this.metrics.inc("cache_hit", 1, { cache: "snapshot_stale" });
        this.loadSnapshot().catch(() => undefined); // background refresh (coalesced)
        return stale.value;
      }
      this.metrics.inc("cache_miss", 1, { cache: "snapshot" });
    }
    return this.loadSnapshot();
  }

  /** Warm the snapshot (server start). */
  async warm(): Promise<void> {
    await this.loadSnapshot();
  }

  private loadSnapshot(): Promise<Snapshot> {
    return this.snapCache.getOrLoad("snap", CACHE_TTL_MS.PRODUCT_SNAPSHOT, async () => {
      const ctx = await this.deps.engine.context();
      const all = await this.deps.engine.getOpportunities({ eligibility: "ALL" }, ctx);
      for (const a of all.adapters) this.metrics.time("adapter_latency_ms", a.timingsMs.total ?? 0, { protocol: a.protocol, status: a.status });
      const byPrimary = new Map<string, Opportunity[]>();
      for (const o of all.data) byPrimary.set(o.primaryAsset.key, [...(byPrimary.get(o.primaryAsset.key) ?? []), o]);
      const tradeMarkets = all.data.flatMap((o) => (o.trade ? [o.trade.market] : []));
      const graph = buildTradeGraph(tradeMarkets);
      const hopOpportunities = new Map(all.data.flatMap((o) => (o.trade ? [[`${o.trade.market.id}|${o.primaryAsset.key}`, o.id] as const] : [])));
      return { ctx, all, byPrimary, graph, markets: new Map(tradeMarkets.map((m) => [m.id, m])), hopOpportunities, takenAt: this.now().getTime() };
    });
  }

  private adapterStatuses(s: Snapshot): AdapterStatus[] {
    return s.all.adapters.map((a) => ({ protocol: a.protocol, status: a.status, issues: a.issues }));
  }

  private resolveAsset(registry: AssetRegistry, input: string): { ref: AssetRef | null; empty: EmptyState | null } {
    const addrPart = input.includes(":") ? input.split(":")[1]! : input;
    if (!isAddress(addrPart, { strict: false })) return { ref: null, empty: "UNKNOWN_ASSET" };
    const address = getAddress(addrPart.toLowerCase()) as Address;
    const a = registry.get(4663, address);
    if (!a) return { ref: null, empty: "UNKNOWN_ASSET" };
    const ref: AssetRef = { key: a.key, chainId: 4663, address, symbol: a.symbol, decimals: a.decimals, canonical: a.canonical, registryType: a.canonical ? a.type : null };
    return { ref, empty: a.canonical ? null : "NON_CANONICAL_ASSET" };
  }

  // ---------------------------------------------------------------- asset intelligence

  async getAssetIntelligence(assetInput: string, opts: AssetQueryOptions = {}): Promise<AssetIntelligence> {
    const t0 = performance.now();
    const mode = opts.mode ?? "PRODUCT";
    const s = await this.snapshot();
    const cacheKey = [s.ctx.chainId, assetInput.toLowerCase(), mode, opts.tradeTarget?.toLowerCase() ?? "-", opts.tradeAmount ?? "-", opts.holding ? `h${opts.holding.rawBalance}` : "-", s.takenAt].join("|");
    const hit = !opts.holding && this.viewCache.get(cacheKey);
    if (hit) {
      this.metrics.inc("cache_hit", 1, { cache: "asset_view" });
      // Cached projection, but freshness is always re-evaluated now.
      return { ...hit.value, freshness: { ...hit.value.freshness, evaluatedAt: this.now().toISOString() } };
    }
    this.metrics.inc("cache_miss", 1, { cache: "asset_view" });
    const view = await this.build(s, assetInput, mode, opts);
    if (!opts.holding) this.viewCache.set(cacheKey, view, CACHE_TTL_MS.PRODUCT_SNAPSHOT);
    this.metrics.time("asset_intelligence_latency_ms", ms(t0), { mode });
    return view;
  }

  async getCategory(assetInput: string, category: ProductCategory, opts: AssetQueryOptions = {}): Promise<CategoryView | null> {
    const v = await this.getAssetIntelligence(assetInput, opts);
    return v.categories.find((c) => c.category === category) ?? null;
  }

  async getRawOpportunities(query: OpportunityQuery = {}): Promise<EngineResult<Opportunity[]>> {
    return this.deps.engine.getOpportunities(query);
  }

  private async build(s: Snapshot, assetInput: string, mode: ProductMode, opts: AssetQueryOptions): Promise<AssetIntelligence> {
    const tp = performance.now();
    const nowS = Math.floor(this.now().getTime() / 1000);
    const generatedAt = this.now().toISOString();
    const { ref, empty } = this.resolveAsset(s.ctx.registry, assetInput);
    const emptyStates: EmptyState[] = empty ? [empty] : [];
    const base: Omit<AssetIntelligence, "categories" | "summary" | "dataQuality" | "freshness" | "otherTradeDestinations" | "tradeTargets"> = {
      mode,
      chainId: s.ctx.chainId,
      asset: ref,
      query: { asset: assetInput, tradeTarget: opts.tradeTarget ?? null, tradeAmount: opts.tradeAmount ?? null },
      balance: null,
      price: null,
      emptyStates,
      blockNumber: s.ctx.blockNumber,
      generatedAt,
    };
    const statuses = this.adapterStatuses(s);
    if (!ref) {
      const freshness = summarizeFreshness([], nowS);
      return { ...base, categories: [], otherTradeDestinations: { direct: 0, oneHop: 0 }, tradeTargets: [], summary: { capabilities: capabilitiesOf([]), counts: emptyCounts(), productCards: 0, protocols: [], allDiscoveredProtocols: [] }, dataQuality: summarizeDataQuality(statuses, freshness), freshness };
    }

    // ---- price (PORTFOLIO_PRICE) and borrow-asset prices, via the Phase 1 Price Service ----
    const opps = s.byPrimary.get(ref.key) ?? [];
    const borrowKeys = [...new Set(opps.flatMap((o) => o.borrowAssets.map((b) => b.key)))];
    const priced = ref.canonical ? await priceCanonicalAssets(s.ctx, [ref.key, ...borrowKeys]) : null;
    const p = priced?.priceOf(ref.key) ?? null;
    const holding = opts.holding ?? null;
    // Prefer the holder's own Phase 1 quote; else the Price Service quote. Freshness is the
    // quote's own (never assumed).
    const q = holding?.price?.status === "PRICED" ? holding.price : p?.quote?.status === "PRICED" ? p.quote : null;
    const priceView: PriceView = q
      ? { kind: "PORTFOLIO_PRICE", usd: q.priceUsdDisplay, method: q.method, observedAt: q.observedAt, freshness: q.freshnessStatus, unpricedReason: null }
      : { kind: "PORTFOLIO_PRICE", usd: null, method: null, observedAt: null, freshness: "UNKNOWN", unpricedReason: !ref.canonical ? "non-canonical asset" : (p?.quote?.unpricedReason ?? "no price from the Phase 1 Price Service") };
    if (!priceView.usd) emptyStates.push("UNPRICED");
    const balance: BalanceView | null =
      holding && holding.rawBalance !== null
        ? {
            rawBalance: holding.rawBalance,
            decimals: holding.asset.decimals,
            displayBalance: holding.displayBalance ?? formatFixed(holding.rawBalance, holding.asset.decimals),
            // Phase 1 semantics, untouched: tokens held + share-equivalent. Pendle's share-unit
            // accounting never changes the token balance shown here.
            stock: holding.stock ? { uiMultiplier: holding.stock.uiMultiplier, displayShareBalance: holding.stock.displayShareBalance, note: "Token balance is the ERC-20 balance; share-equivalent = tokens × uiMultiplier (display only)." } : null,
            valueUsd: holding.valueUsdE18 === null ? null : usd(holding.valueUsdE18),
          }
        : null;
    if (!holding) emptyStates.push("NO_BALANCE");

    // ---- non-trade cards (every raw opportunity with this primary asset) ----
    const counts = emptyCounts();
    const cardCtx = { nowS, holding, borrowPriceOf: (k: string) => priced?.priceOf(k).price ?? null };
    const allCards: ProductCard[] = [];
    const seen = new Map<string, ProductCard>();
    for (const o of opps) {
      const u = classifyOpportunity(o);
      addCount(counts, o, u);
      if (o.category === "TRADE") continue; // trade is presented as routes below
      if (!productCategoryOf(o.category)) continue;
      const c = opportunityCard(o, cardCtx, u);
      const dup = seen.get(c.cardId);
      if (dup) dup.sourceOpportunityIds.push(...c.sourceOpportunityIds); // same user action: one card
      else {
        seen.set(c.cardId, c);
        allCards.push(c);
      }
    }

    // ---- trade: routes to default targets (or the explicit target), quoted only with an amount ----
    const explicitTarget = opts.tradeTarget ? this.resolveAsset(s.ctx.registry, opts.tradeTarget).ref : null;
    const targets = explicitTarget ? [explicitTarget.key] : PRODUCT_TRADE_TARGET_KEYS.filter((k) => k !== ref.key);
    let amountRaw: bigint | null = null;
    // An amount is quoted only against ONE explicit target (never inferred, never a whole balance).
    if (opts.tradeAmount !== undefined && !opts.tradeTarget) throw new Error("tradeAmount requires tradeTarget");
    if (opts.tradeAmount !== undefined && explicitTarget) {
      if (!/^\d+(\.\d+)?$/.test(opts.tradeAmount)) throw new Error("tradeAmount must be a positive decimal string");
      amountRaw = parseUnits(opts.tradeAmount, ref.decimals);
      if (amountRaw <= 0n) throw new Error("tradeAmount must be positive");
    }
    const tradeGroups: { target: string; cards: ProductCard[] }[] = [];
    if (ref.canonical) {
      for (const target of targets) {
        const found = findRoutes(s.graph, ref.key, target);
        const routes: TradeRoute[] = [...found.direct, ...found.oneHop];
        const quoteCard = async (r: TradeRoute): Promise<ProductCard> => {
          const tq = performance.now();
          const q = await this.deps.engine.getTradeQuote(r, amountRaw!, s.ctx);
          this.metrics.time("quote_latency_ms", ms(tq), { kind: r.kind });
          if (q.ok) return routeCard(r, s, classifyQuotedRoute(r, q.quote, nowS, Number(s.ctx.blockTimestamp)), { q: q.quote, nowS });
          return routeCard(r, s, { status: "LIMITED", reasons: ["PRICE_IMPACT_UNKNOWN"], notes: ["VOLUME_UNKNOWN"], policies: [] }, null, q.reason);
        };
        const cards: ProductCard[] = amountRaw === null ? routes.map((r) => routeCard(r, s, classifyRoute(r), null)) : await mapLimit(routes, QUOTE_CONCURRENCY, quoteCard);
        tradeGroups.push({ target, cards });
      }
    }
    const tradeCards = tradeGroups.flatMap((g) => g.cards);
    const dest = ref.canonical ? destinations(s.graph, ref.key) : { direct: [], oneHop: [] };
    const otherTradeDestinations = { direct: dest.direct.filter((d) => !targets.includes(d)).length, oneHop: dest.oneHop.filter((d) => !targets.includes(d)).length };
    const symbolOf = (key: string) => {
      const addr = key.split(":")[1];
      return addr ? (s.ctx.registry.get(s.ctx.chainId, addr as Address)?.symbol ?? null) : null;
    };
    const tradeTargets: AssetIntelligence["tradeTargets"] = [
      ...dest.direct.map((key) => ({ key, kind: "DIRECT" as const })),
      ...dest.oneHop.map((key) => ({ key, kind: "ONE_HOP" as const })),
    ]
      .map((x) => ({ ...x, symbol: symbolOf(x.key) }))
      .filter((x): x is AssetIntelligence["tradeTargets"][number] => x.symbol !== null);

    // ---- categories: rank within each subcategory (and within each trade target) ----
    const visible = (c: ProductCard) => DEFAULT_VISIBLE.has(c.usability.status);
    const categories: CategoryView[] = [];
    for (const cat of PRODUCT_CATEGORY_ORDER) {
      const subs: CategoryView["subcategories"] = [];
      for (const sub of SUBCATEGORY_ORDER[cat]) {
        if (sub === "TRADE") {
          const moreRoutes: { target: string; shown: number; total: number }[] = [];
          const ranked = tradeGroups.flatMap((g) => {
            const vs = g.cards.filter(visible);
            const all = vs.length ? rankCards(vs, "TRADE", { target: g.target, ...(amountRaw !== null ? { inputAmount: opts.tradeAmount! } : {}) }) : [];
            if (mode === "DEBUG" || all.length <= PRODUCT_MAX_ROUTES_PER_TARGET) return all;
            moreRoutes.push({ target: g.target, shown: PRODUCT_MAX_ROUTES_PER_TARGET, total: all.length });
            return all.slice(0, PRODUCT_MAX_ROUTES_PER_TARGET);
          });
          if (ranked.length) subs.push({ subcategory: sub, comparator: ranked[0]!.ranking!.comparator, cards: ranked, ...(moreRoutes.length ? { moreRoutes } : {}) });
          continue;
        }
        const vs = allCards.filter((c) => c.subcategory === sub && visible(c));
        if (vs.length) {
          const ranked = rankCards(vs, sub);
          subs.push({ subcategory: sub, comparator: ranked[0]!.ranking!.comparator, cards: ranked });
        }
      }
      if (subs.length) categories.push({ category: cat, subcategories: subs });
    }
    const productCards = categories.flatMap((c) => c.subcategories.flatMap((x) => x.cards));
    const everyCard = [...allCards, ...tradeCards];
    const usable = everyCard.filter((c) => c.usability.status === "ACTIONABLE" || c.usability.status === "LIMITED");
    if (opps.length === 0 && tradeCards.length === 0) emptyStates.push("NO_OPPORTUNITIES");
    else if (productCards.length === 0) emptyStates.push("NO_USABLE_OPPORTUNITIES");
    if (statuses.length && statuses.every((a) => a.status === "UNKNOWN")) emptyStates.push("ADAPTERS_UNAVAILABLE");

    // ---- quality and freshness (evaluated now) ----
    const visibleOppIds = new Set(productCards.flatMap((c) => c.sourceOpportunityIds));
    const timed: TimedValue[] = opps.filter((o) => visibleOppIds.has(o.id)).flatMap(criticalValues);
    const freshness = summarizeFreshness(timed, nowS);
    if (priceView.freshness === "STALE" || priceView.freshness === "UNKNOWN") {
      if (priceView.usd) freshness.staleSources.push({ provider: "Phase 1 Price Service", status: priceView.freshness, ageSeconds: null, what: "PORTFOLIO_PRICE" });
    }
    const extra: DataQuality["reasons"] = priceView.usd ? [] : [{ code: "PRICE_UNAVAILABLE", detail: priceView.unpricedReason ?? "unpriced" }];
    const dataQuality = summarizeDataQuality(statuses, freshness, extra);

    for (const [k, n] of [["opportunities_discovered", counts.discovered], ["opportunities_actionable", counts.actionable], ["opportunities_limited", counts.limited], ["opportunities_hidden", counts.hidden + counts.unavailable]] as const) this.metrics.inc(k, n);
    for (const [r, n] of Object.entries(counts.hiddenByReason)) this.metrics.inc("hidden_by_reason", n ?? 0, { reason: r });
    this.metrics.time("projection_latency_ms", ms(tp));

    const view: AssetIntelligence = {
      ...base,
      balance,
      price: priceView,
      categories,
      otherTradeDestinations,
      tradeTargets,
      summary: {
        capabilities: capabilitiesOf(everyCard),
        counts,
        productCards: productCards.length,
        protocols: [...new Set(usable.map((c) => c.protocol.name))].sort(),
        allDiscoveredProtocols: [...new Set(opps.map((o) => o.protocol.name))].sort(),
      },
      dataQuality,
      freshness,
    };
    if (mode === "DEBUG") view.excluded = everyCard.filter((c) => !visible(c));
    return view;
  }

  // ---------------------------------------------------------------- portfolio

  async getPortfolioIntelligence(wallet: string, opts: { mode?: ProductMode } = {}): Promise<PortfolioIntelligence> {
    const t0 = performance.now();
    // The wallet only reaches the Phase 1 balance reader (onchain balanceOf); never a protocol API.
    const portfolio = await this.deps.getPortfolio(wallet);
    const s = await this.snapshot();
    const nowS = Math.floor(this.now().getTime() / 1000);
    const held = portfolio.assets.filter((r) => r.balanceStatus === "OK" && (r.rawBalance ?? 0n) > 0n);
    const assets: AssetIntelligence[] = [];
    const unsupported: PortfolioIntelligence["unsupportedAssets"] = [];
    let counts = emptyCounts();
    let supported = 0n;
    let unsupportedValue = 0n;
    for (const row of held) {
      if (!row.asset.canonical || !row.asset.address) {
        unsupported.push({ asset: { symbol: row.asset.symbol, key: row.asset.key }, reason: row.asset.canonical ? "native asset (no token opportunities)" : "non-canonical asset", valueUsd: row.valueUsd });
        if (row.valueUsdE18) unsupportedValue += row.valueUsdE18;
        continue;
      }
      const v = await this.build(s, row.asset.key, opts.mode ?? "PRODUCT", { holding: row });
      assets.push(v);
      counts = mergeCounts(counts, v.summary.counts);
      // Supported = at least one ACTIONABLE or LIMITED intent (informational-only is not support).
      const hasUsable = Object.values(v.summary.capabilities.detail).some((d) => d === "ACTIONABLE" || d === "LIMITED_ONLY");
      if (row.valueUsdE18) {
        if (hasUsable) supported += row.valueUsdE18;
        else unsupportedValue += row.valueUsdE18;
      }
    }
    const statuses = this.adapterStatuses(s);
    const freshness = summarizeFreshness([], nowS);
    freshness.oldestCriticalDataAt = assets.map((a) => a.freshness.oldestCriticalDataAt).filter((x): x is string => !!x).sort()[0] ?? null;
    freshness.newestDataAt = assets.map((a) => a.freshness.newestDataAt).filter((x): x is string => !!x).sort().at(-1) ?? null;
    freshness.staleSources = [...new Map(assets.flatMap((a) => a.freshness.staleSources).map((x) => [`${x.provider}|${x.what}|${x.status}`, x])).values()];
    const extra: DataQuality["reasons"] = portfolio.valuationCoverage.coverageStatus === "COMPLETE" ? [] : [{ code: `PORTFOLIO_VALUATION_${portfolio.valuationCoverage.coverageStatus}`, detail: `${portfolio.valuationCoverage.unpricedAssets} unpriced, ${portfolio.valuationCoverage.failedBalances} failed balances` }];
    this.metrics.time("portfolio_intelligence_latency_ms", ms(t0));
    return {
      chainId: s.ctx.chainId,
      wallet: portfolio.walletAddress,
      portfolioValueUsd: portfolio.valuationCoverage.totalValueUsd,
      pricedValueUsd: portfolio.totals.pricedValueUsd,
      supportedAssetValueUsd: formatFixed(supported, USD_DECIMALS),
      unsupportedAssetValueUsd: formatFixed(unsupportedValue, USD_DECIMALS),
      unpricedAssetCount: portfolio.totals.unpricedAssetCount,
      assets,
      unsupportedAssets: unsupported,
      opportunityCounts: counts,
      dataQuality: summarizeDataQuality(statuses, freshness, extra),
      freshness,
      blockNumber: s.ctx.blockNumber,
      generatedAt: this.now().toISOString(),
    };
  }

  // ---------------------------------------------------------------- coverage

  async getCoverage(): Promise<CoverageRow[]> {
    const t0 = performance.now();
    const s = await this.snapshot();
    const canonical = s.ctx.registry.canonical().filter((a) => a.address !== null);
    const priced = await priceCanonicalAssets(s.ctx, canonical.map((a) => a.key));
    const rows: CoverageRow[] = canonical.map((a) => {
      const ref: AssetRef = { key: a.key, chainId: 4663, address: a.address!, symbol: a.symbol, decimals: a.decimals, canonical: true, registryType: a.type };
      const opps = s.byPrimary.get(a.key) ?? [];
      const byRawCategory: CoverageRow["byRawCategory"] = { TRADE: 0, LEND: 0, VAULT: 0, COLLATERAL: 0, FIXED_YIELD: 0, YIELD: 0, LP: 0 };
      const c = emptyCounts();
      const items: { category: ProductCategory; usability: UsabilityResult; protocol: string }[] = [];
      for (const o of opps) {
        const u = classifyOpportunity(o);
        addCount(c, o, u);
        if (o.category in byRawCategory) byRawCategory[o.category as keyof typeof byRawCategory]++;
        // capability: raw opportunity usability (per market; trade routes are not quoted here)
        const pc = productCategoryOf(o.category);
        if (pc) items.push({ category: pc.category, usability: u, protocol: o.protocol.name });
      }
      const pq = priced.priceOf(a.key).quote;
      return {
        asset: ref,
        portfolioPriceUsd: pq?.status === "PRICED" ? pq.priceUsdDisplay : null,
        priceFreshness: pq?.status === "PRICED" ? pq.freshnessStatus : null,
        byRawCategory,
        actionable: c.actionable,
        limited: c.limited,
        informational: c.informational,
        hidden: c.hidden,
        unavailable: c.unavailable,
        protocols: [...new Set(items.filter((x) => x.usability.status === "ACTIONABLE" || x.usability.status === "LIMITED").map((x) => x.protocol))].sort(),
        capabilities: capabilitiesOf(items),
      };
    });
    this.metrics.time("coverage_latency_ms", ms(t0));
    return rows;
  }
}
