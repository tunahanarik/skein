/**
 * AssetIntelligenceService — the product read API boundary (docs/asset-intelligence.md).
 * A future HTTP route can call these methods directly. Read-only; nothing here quotes a whole
 * balance, persists a wallet address or sends one to a protocol API.
 *
 *   getAssetIntelligence(asset, opts)      one asset, PRODUCT or DEBUG mode, optional trade target/amount
 *   getCategory(asset, category, opts)     one product category of that view
 *   getPortfolioIntelligence(wallet, opts) every held canonical asset (positions=false leaves them out)
 *   getPortfolioPositions(wallet)          open protocol positions alone (the slow part of a wallet)
 *   getCoverage()                        machine-readable coverage matrix for all canonical assets
 *   getRawOpportunities(query)             RAW mode: the engine's untouched output
 */
import { getAddress, isAddress, parseUnits, type Address } from "viem";
import { CACHE_TTL_MS } from "@skein/core/config/freshness";
import { PRODUCT_MAX_ROUTES_PER_TARGET, PRODUCT_QUOTE_TIMEOUT_MS, PRODUCT_TRADE_TARGET_KEYS, QUOTE_CONCURRENCY } from "@skein/robinhood/config/trade";
import { TtlCache } from "@skein/core/lib/cache";
import { formatFixed, USD_DECIMALS } from "@skein/core/lib/units";
import { BUCKET_MS, CHART_TTL_MS, deviation, MAX_DEVIATION, RANGE_MS, resample, shareToToken, summarize, type ChainlinkRounds, type PriceChartData } from "./charts.js";
import { RH_MARKET_BASE, RH_QUERY, type ChartRange, type ShareBar } from "@skein/robinhood/sources/rhMarket";
import type { LiveFeed, LiveMarket } from "./liveTypes.js";
import { chainlinkAggregatorAbi } from "@skein/core/config/abis";
import type { AssetRef, Opportunity, TokenAmount, UsdAmount } from "@skein/core/model/opportunity";
import type { Position } from "@skein/core/model/position";
import type { TradeMarket, TradeRoute } from "@skein/core/model/trade";
import { isAuthoritative } from "@skein/core/model/verification";
import type { AdapterContext } from "@skein/engine/opportunities/adapter";
import { priceCanonicalAssets } from "@skein/engine/opportunities/assetPricing";
import { headlineMetric } from "@skein/engine/opportunities/headline";
import type { EngineResult, OpportunityEngine, OpportunityQuery } from "@skein/engine/opportunities/engine";
import type { Portfolio, PortfolioAsset } from "@skein/portfolio/types";
import type { AssetRegistry } from "@skein/robinhood/registry/registry";
import type { PriceService } from "@skein/pricing/priceService";
import type { VolumeSource } from "@skein/robinhood/sources/geckoterminal";
import { buildTradeGraph, destinations, findRoutes, type TradeGraph } from "@skein/engine/trade/graph";
import { isOutlierRate, opportunityCard, routeCard } from "./cards.js";
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
  PortfolioPositions,
  PositionView,
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
  /** Phase 1 Price Service, for price history (optional; history is unavailable without it). */
  prices?: PriceService;
  /** Third-party 24h pool volume (display only). */
  volumes?: VolumeSource;
  /**
   * Reader for reads made on behalf of one user (position reads). The snapshot's own reader may
   * yield to user requests (RpcPriority), so user work must not go through it.
   */
  foregroundReader?: AdapterContext["reader"];
  /** Chainlink round history for charts (full feed history, incremental). */
  chartRounds?: ChainlinkRounds;
  /** Underlying share price history for Stock Token charts (Robinhood market data). */
  shareHistory?: (symbol: string, range: ChartRange) => Promise<ShareBar[]>;
  /** Latest share price and previous close by ticker (Robinhood market data), for daily change. */
  shareQuotes?: (symbols: string[]) => Promise<Map<string, { last: number; prevClose: number; at: string | null }>>;
  /** Called with every new engine snapshot (e.g. to record rate history). Errors are ignored. */
  onSnapshot?: (opps: readonly Opportunity[], takenAt: number) => void;
}

export interface MarketRow {
  key: string;
  symbol: string;
  name: string;
  type: string;
  address: string;
  usd: number | null;
  /** Today's change in percent units, or null. */
  changePct: number | null;
  /** Highest headline yield (percent) among usable earn, fixed-yield and LP opportunities, and its protocol. */
  bestApy: number | null;
  bestApyProtocol: string | null;
  /** What a holder can do with it (usable = actionable or limited opportunities). */
  caps: { earn: boolean; fixed: boolean; borrow: boolean; lp: boolean };
  /** USD value locked in the trade pools that hold this asset (display only), or null. */
  liquidityUsd: number | null;
}

/**
 * Categories whose headline yield a holder actually earns. YIELD (Pendle YT "long yield") is left
 * out: its APY is a leveraged what-if (37,000 % on SGOV, 2026-10-01), not a holder's return.
 */
const EARN_SIDE = new Set(["LEND", "VAULT", "FIXED_YIELD", "LP"]);
/** Per-asset summary of its opportunities for the Markets page. */
function marketExtras(opps: Opportunity[]): Pick<MarketRow, "bestApy" | "bestApyProtocol" | "caps" | "liquidityUsd"> {
  const caps = { earn: false, fixed: false, borrow: false, lp: false };
  let bestApy: number | null = null;
  let bestApyProtocol: string | null = null;
  let liq = 0n;
  let liqSeen = false;
  for (const o of opps) {
    if (o.category === "TRADE") {
      const usdE18 = o.tvl?.value.usd?.e18 ?? null;
      if (usdE18 !== null) {
        liq += usdE18;
        liqSeen = true;
      }
      continue;
    }
    const st = classifyOpportunity(o).status;
    if (st !== "ACTIONABLE" && st !== "LIMITED") continue;
    if (o.category === "LEND" || o.category === "VAULT" || o.category === "YIELD") caps.earn = true;
    if (o.category === "FIXED_YIELD") caps.fixed = true;
    if (o.category === "COLLATERAL") caps.borrow = true;
    if (o.category === "LP") caps.lp = true;
    if (!EARN_SIDE.has(o.category)) continue;
    const h = headlineMetric(o);
    // Outliers (above 100 %) never become an asset's "top yield" (D1).
    if (!h || h.side !== "EARN" || isOutlierRate(h)) continue;
    const v = Number(h.value) / 1e16;
    if (Number.isFinite(v) && v > 0 && (bestApy === null || v > bestApy)) {
      bestApy = v;
      bestApyProtocol = o.protocol.name;
    }
  }
  return { bestApy, bestApyProtocol, caps, liquidityUsd: liqSeen ? Number(liq / 10n ** 14n) / 1e4 : null };
}

export interface PriceHistory {
  asset: AssetRef;
  kind: "PORTFOLIO_PRICE";
  source: { provider: "Chainlink"; feed: string; proxy: string } | null;
  /** Oldest first. Chainlink rounds as published (Stock Token feeds include the multiplier). */
  points: { t: string; usd: string }[];
  change: { from: string; to: string; pct: string } | null;
  generatedAt: string;
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

/** Quotes in flight across ALL requests (mapLimit bounds one request): parallel amount queries cannot multiply RPC load. */
const QUOTE_GLOBAL_CONCURRENCY = 24;

/** A counting gate shared by every request. */
class Gate {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    while (this.active >= this.size) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await f();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

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

/** Position adapters that did not complete, as data quality statuses (unknown when the read failed). */
function positionStatuses(pos: EngineResult<Position[]> | null): AdapterStatus[] {
  if (!pos) return [{ protocol: "positions", status: "UNKNOWN", issues: [] }];
  return pos.adapters.filter((a) => a.status !== "COMPLETE").map((a) => ({ protocol: `${a.protocol}_positions`, status: a.status, issues: a.issues }));
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
  private readonly quoteGate = new Gate(QUOTE_GLOBAL_CONCURRENCY);

  constructor(private readonly deps: IntelligenceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.metrics = deps.metrics ?? new Metrics();
    this.snapCache = new TtlCache<Snapshot>(() => this.now().getTime());
    // Views are large; 200 covers every canonical asset in each mode with room to spare.
    this.viewCache = new TtlCache<AssetIntelligence>(() => this.now().getTime(), { maxEntries: 200 });
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
      const takenAt = this.now().getTime();
      try {
        this.deps.onSnapshot?.(all.data, takenAt);
      } catch {
        /* history is best effort */
      }
      return { ctx, all, byPrimary, graph, markets: new Map(tradeMarkets.map((m) => [m.id, m])), hopOpportunities, takenAt };
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
    // Holding-aware and amount-quoted views are never cached: each is specific to one request.
    const cacheable = !opts.holding && opts.tradeAmount === undefined;
    const hit = cacheable && this.viewCache.get(cacheKey);
    if (hit) {
      this.metrics.inc("cache_hit", 1, { cache: "asset_view" });
      // Cached projection, but freshness is always re-evaluated now.
      return { ...hit.value, freshness: { ...hit.value.freshness, evaluatedAt: this.now().toISOString() } };
    }
    this.metrics.inc("cache_miss", 1, { cache: "asset_view" });
    const view = await this.build(s, assetInput, mode, opts);
    if (cacheable) this.viewCache.set(cacheKey, view, CACHE_TTL_MS.PRODUCT_SNAPSHOT);
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
    const priced = ref.canonical ? await priceCanonicalAssets(this.userCtx(s), [ref.key, ...borrowKeys]) : null;
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
          const q = await this.quoteGate.run(() => this.deps.engine.getTradeQuote(r, amountRaw!, this.userCtx(s), PRODUCT_QUOTE_TIMEOUT_MS));
          this.metrics.time("quote_latency_ms", ms(tq), { kind: r.kind });
          if (q.ok) return routeCard(r, s, classifyQuotedRoute(r, q.quote, nowS, Number(s.ctx.blockTimestamp)), { q: q.quote, nowS });
          return routeCard(r, s, { status: "LIMITED", reasons: ["PRICE_IMPACT_UNKNOWN"], notes: ["VOLUME_UNKNOWN"], policies: [] }, null, q.reason);
        };
        // A route through two venues has no single quoter: it stays in the route view but is not
        // offered as a quote for an amount (its output cannot be estimated consistently).
        const quotable = routes.filter((r) => new Set(r.properties.protocols).size === 1);
        const cards: ProductCard[] = amountRaw === null ? routes.map((r) => routeCard(r, s, classifyRoute(r), null)) : await mapLimit(quotable, QUOTE_CONCURRENCY, quoteCard);
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
    // Third-party 24h volume for the pools of the routes actually shown (display only, bounded wait).
    // Skipped for an amount quote: the swap panel waits on it, and volume is not part of a quote.
    if (this.deps.volumes && amountRaw === null) {
      const shown = productCards.filter((c) => c.trade);
      const poolOf = (marketId: string) => marketId.split(":").at(-1)!.toLowerCase();
      const pools = [...new Set(shown.flatMap((c) => c.trade!.route.markets.map((m) => poolOf(m.marketId))))];
      // A wallet view builds every held asset at once: answer from cached volumes without waiting
      // (the call still refreshes the cache for the next view); a single asset page waits briefly.
      const vols = pools.length ? await this.deps.volumes.get(pools, { timeoutMs: opts.holding ? 0 : 2_000 }).catch(() => new Map()) : new Map();
      for (const c of shown) {
        for (const m of c.trade!.route.markets) {
          const v = vols.get(poolOf(m.marketId));
          if (v) m.volume24h = { usd: v.usd24h, txs: v.txs24h, observedAt: v.observedAt, source: v.source, url: v.url };
        }
        if (c.trade!.route.markets.every((m) => m.volume24h)) c.usability.notes = c.usability.notes.filter((n) => n !== "VOLUME_UNKNOWN");
      }
    }
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
        protocols: [...new Set(usable.flatMap((c) => c.protocol.name.split(" + ")))].sort(),
        allDiscoveredProtocols: [...new Set(opps.map((o) => o.protocol.name))].sort(),
      },
      dataQuality,
      freshness,
    };
    if (mode === "DEBUG") view.excluded = everyCard.filter((c) => !visible(c));
    return view;
  }

  // ---------------------------------------------------------------- portfolio

  async getPortfolioIntelligence(wallet: string, opts: { mode?: ProductMode; positions?: boolean } = {}): Promise<PortfolioIntelligence> {
    const t0 = performance.now();
    const withPositions = opts.positions !== false;
    // Balances, the snapshot and (once the snapshot is there) positions run side by side; the
    // wallet only reaches onchain reads (balanceOf, position reads), never a protocol API.
    const snap = this.snapshot();
    const posP = withPositions ? snap.then((s) => this.deps.engine.getUserPositions(wallet, this.userCtx(s))).catch(() => null) : Promise.resolve(null);
    const [portfolio, s] = await Promise.all([this.deps.getPortfolio(wallet), snap]);
    const nowS = Math.floor(this.now().getTime() / 1000);
    const held = portfolio.assets.filter((r) => r.balanceStatus === "OK" && (r.rawBalance ?? 0n) > 0n);
    const unsupported: PortfolioIntelligence["unsupportedAssets"] = [];
    let unsupportedValue = 0n;
    const covered: PortfolioAsset[] = [];
    for (const row of held) {
      if (row.asset.canonical && row.asset.address) {
        covered.push(row);
        continue;
      }
      unsupported.push({ asset: { symbol: row.asset.symbol, key: row.asset.key }, reason: row.asset.canonical ? "native asset (no token opportunities)" : "non-canonical asset", valueUsd: row.valueUsd });
      if (row.valueUsdE18) unsupportedValue += row.valueUsdE18;
    }
    // Every held asset's view at once (each is a projection of the shared snapshot).
    const assets = await Promise.all(covered.map((row) => this.build(s, row.asset.key, opts.mode ?? "PRODUCT", { holding: row })));
    let counts = emptyCounts();
    let supported = 0n;
    assets.forEach((v, i) => {
      const row = covered[i]!;
      counts = mergeCounts(counts, v.summary.counts);
      // Supported = at least one ACTIONABLE or LIMITED intent (informational-only is not support).
      const hasUsable = Object.values(v.summary.capabilities.detail).some((d) => d === "ACTIONABLE" || d === "LIMITED_ONLY");
      if (row.valueUsdE18) {
        if (hasUsable) supported += row.valueUsdE18;
        else unsupportedValue += row.valueUsdE18;
      }
    });
    const pos = await posP;
    const positions = this.positionViews(pos, s, assets);
    const statuses = this.adapterStatuses(s);
    if (withPositions) statuses.push(...positionStatuses(pos));
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
      positions,
      unsupportedAssets: unsupported,
      opportunityCounts: counts,
      dataQuality: summarizeDataQuality(statuses, freshness, extra),
      freshness,
      blockNumber: s.ctx.blockNumber,
      generatedAt: this.now().toISOString(),
    };
  }

  /** Open positions alone, for a wallet view that loads them beside its holdings. */
  async getPortfolioPositions(wallet: string): Promise<PortfolioPositions> {
    const t0 = performance.now();
    const s = await this.snapshot();
    const pos = await this.deps.engine.getUserPositions(wallet, this.userCtx(s)).catch(() => null);
    // Card ids for "view market" come from the views of the assets these positions touch.
    const keys = [...new Set((pos?.data ?? []).flatMap((p) => p.assets.filter((a) => a.canonical).map((a) => a.key)))];
    const views = await Promise.all(keys.map((k) => this.getAssetIntelligence(k).catch(() => null)));
    const positions = this.positionViews(pos, s, views.filter((v): v is AssetIntelligence => !!v));
    this.metrics.time("portfolio_positions_latency_ms", ms(t0));
    return {
      chainId: s.ctx.chainId,
      positions,
      dataQuality: summarizeDataQuality(positionStatuses(pos), summarizeFreshness([], Math.floor(this.now().getTime() / 1000)), []),
      blockNumber: s.ctx.blockNumber,
      generatedAt: this.now().toISOString(),
    };
  }

  /** The snapshot context with the user-facing reader and Price Service (same block, same registry). */
  private userCtx(s: Snapshot): AdapterContext {
    if (!this.deps.foregroundReader) return s.ctx;
    return { ...s.ctx, reader: this.deps.foregroundReader, ...(this.deps.prices ? { prices: this.deps.prices } : {}) };
  }

  private positionViews(pos: EngineResult<Position[]> | null, s: Snapshot, assets: AssetIntelligence[]): PositionView[] {
    const oppById = new Map(s.all.data.map((o) => [o.id, o]));
    const cardIdsByOpp = new Map<string, string[]>();
    for (const a of assets) for (const c of a.categories.flatMap((x) => x.subcategories.flatMap((y) => y.cards))) for (const id of c.sourceOpportunityIds) cardIdsByOpp.set(id, [...(cardIdsByOpp.get(id) ?? []), c.cardId]);
    const amt = (m: { value: { amount: TokenAmount | null; usd: UsdAmount | null; asset: AssetRef } } | null) => (m ? { amount: m.value.amount, usd: m.value.usd, asset: m.value.asset } : null);
    return (pos?.data ?? [])
      .map((p) => {
        const related = p.relatedOpportunityIds.map((id) => oppById.get(id)).filter((o): o is Opportunity => !!o);
        return {
          id: p.id,
          protocol: { ...p.protocol },
          kind: p.kind,
          label: related[0]?.title ?? null,
          assets: p.assets,
          supplied: amt(p.supplied),
          borrowed: amt(p.borrowed),
          collateral: amt(p.collateral),
          healthFactor: p.healthFactor?.value ?? null,
          ltv: p.ltv?.value ?? null,
          liquidationLtv: related.find((o) => o.liquidation)?.liquidation?.lltv.value ?? null,
          liquidatable: p.liquidatable,
          maturity: p.maturity ?? null,
          venueAddress: p.venue.address,
          observedAt: p.supplied?.observedAt ?? p.collateral?.observedAt ?? p.borrowed?.observedAt ?? null,
          freshness: p.freshness.status,
          warnings: p.warnings.map((w) => w.code),
          relatedCardIds: [...new Set(p.relatedOpportunityIds.flatMap((id) => cardIdsByOpp.get(id) ?? []))],
        };
      })
      .sort((a, b) => Number(b.borrowed !== null) - Number(a.borrowed !== null) || Number(b.supplied?.usd?.display ?? b.collateral?.usd?.display ?? 0) - Number(a.supplied?.usd?.display ?? a.collateral?.usd?.display ?? 0));
  }

  // ---------------------------------------------------------------- price history

  private readonly historyCache = new TtlCache<PriceHistory>(() => this.now().getTime());

  async getPriceHistory(assetInput: string): Promise<PriceHistory | null> {
    const s = await this.snapshot();
    const { ref } = this.resolveAsset(s.ctx.registry, assetInput);
    if (!ref || !ref.canonical || !this.deps.prices) return null;
    const asset = s.ctx.registry.get(s.ctx.chainId, ref.address)!;
    return this.historyCache.getOrLoad(ref.key, 60_000, async () => {
      const h = await this.deps.prices!.feedHistory(asset, s.ctx.blockNumber).catch(() => null);
      const points = (h?.points ?? []).map((p) => ({ t: new Date(p.updatedAt * 1000).toISOString(), usd: formatFixed(p.answer, p.decimals) }));
      const first = h?.points[0];
      const last = h?.points.at(-1);
      // Exact change in 1e18 fixed point, then formatted.
      const change = first && last && first.answer > 0n ? { from: points[0]!.usd, to: points.at(-1)!.usd, pct: formatFixed(((last.answer - first.answer) * 10n ** 20n) / first.answer, 18) } : null;
      return { asset: ref, kind: "PORTFOLIO_PRICE", source: h ? { provider: "Chainlink", feed: h.feed.name, proxy: h.feed.proxyAddress } : null, points, change, generatedAt: this.now().toISOString() };
    });
  }

  // ---------------------------------------------------------------- live prices (apps/server/src/live.ts)

  /** The asset's most liquid active pool markets (Uniswap v3/v4, Ramses) by TVL, for live pair prices. */
  async liveMarkets(assetKey: string, limit: number): Promise<LiveMarket[]> {
    const s = await this.snapshot();
    const venue = (id: string) => (id === "uniswap" ? "Uniswap v3" : id === "uniswap-v4" ? "Uniswap v4" : id === "ramses" ? "Ramses" : id);
    const tvl = (m: TradeMarket) => Number(m.liquidity.tvl?.value.display ?? 0);
    return [...s.markets.values()]
      .filter((m) => m.state === "ACTIVE" && m.assets.some((a) => a.key === assetKey) && m.assets.every((a) => a.canonical))
      .filter((m) => (m.protocol.id === "uniswap-v4" ? /^0x[0-9a-f]{64}$/i.test(m.marketId) : !!m.address))
      .sort((a, b) => tvl(b) - tvl(a))
      .slice(0, limit)
      .map((m) => ({
        id: m.id,
        venue: venue(m.protocol.id),
        kind: m.protocol.id === "uniswap-v4" ? ("V4" as const) : ("V3" as const),
        target: m.protocol.id === "uniswap-v4" ? m.marketId : m.address!,
        feePpm: m.fee?.value.ppm ?? null,
        tvlUsd: m.liquidity.tvl?.value.display ?? null,
        a0: { key: m.assets[0].key, symbol: m.assets[0].symbol, decimals: m.assets[0].decimals },
        a1: { key: m.assets[1].key, symbol: m.assets[1].symbol, decimals: m.assets[1].decimals },
      }));
  }

  /** The asset's Chainlink feed (proxy + decimals), for live USD prices. */
  async liveFeed(assetKey: string): Promise<LiveFeed | null> {
    const s = await this.snapshot();
    const asset = s.ctx.registry.canonical().find((a) => a.key === assetKey);
    if (!asset || !this.deps.prices) return null;
    const feed = await this.deps.prices.feedFor(asset).catch(() => null);
    if (!feed) return null;
    const [dec] = await this.userCtx(s).reader.multicall([{ address: feed.proxyAddress, abi: chainlinkAggregatorAbi, functionName: "decimals" }], { blockNumber: s.ctx.blockNumber });
    return dec?.status === "success" ? { key: asset.key, symbol: asset.symbol, proxy: feed.proxyAddress, decimals: Number(dec.result) } : null;
  }

  private readonly marketsCache = new TtlCache<MarketRow[]>(() => this.now().getTime());

  /**
   * Every canonical asset with its USD price (Chainlink / Phase 1) and today's change. Stock
   * Tokens: the underlying share's change vs the previous close (Robinhood market data; the
   * multiplier cancels out). ETH/USDG: the 1D Chainlink chart. Cached for a minute.
   */
  async getMarkets(): Promise<MarketRow[]> {
    return this.marketsCache.getOrLoad("all", 60_000, async () => {
      const s = await this.snapshot();
      const assets = s.ctx.registry.canonical().filter((a) => a.address);
      const prices = await this.usdPrices(assets.map((a) => a.key));
      const quotes = this.deps.shareQuotes ? await this.deps.shareQuotes(assets.filter((a) => a.type === "STOCK_TOKEN").map((a) => a.stockMetadata?.rhSymbol ?? a.symbol)).catch(() => new Map()) : new Map();
      const rows: MarketRow[] = [];
      for (const a of assets) {
        let change: number | null = null;
        if (a.type === "STOCK_TOKEN") {
          const q = quotes.get((a.stockMetadata?.rhSymbol ?? a.symbol).toUpperCase());
          if (q) change = (q.last / q.prevClose - 1) * 100;
        } else {
          const c = await this.getPriceChart(a.key, "1D").catch(() => null);
          change = c?.changePct != null ? Number(c.changePct) : null;
        }
        rows.push({ key: a.key, symbol: a.symbol, name: a.name, type: a.type, address: a.address!, usd: prices.get(a.key) ?? null, changePct: change, ...marketExtras(s.byPrimary.get(a.key) ?? []) });
      }
      return rows;
    });
  }

  /** Chainlink/Phase 1 USD prices of canonical assets, as numbers (for classification only). */
  async usdPrices(keys: string[]): Promise<Map<string, number>> {
    const s = await this.snapshot();
    const priced = await priceCanonicalAssets(this.userCtx(s), keys);
    const out = new Map<string, number>();
    for (const k of keys) {
      const p = priced.priceOf(k).price;
      if (p) out.set(k, Number(formatFixed(p.raw, p.decimals)));
    }
    return out;
  }

  /** Canonical Stock Tokens (for the aggregator scan). */
  async stockTokens(): Promise<{ key: string; symbol: string; address: `0x${string}`; decimals: number }[]> {
    const s = await this.snapshot();
    return s.ctx.registry
      .canonical()
      .filter((a) => a.type === "STOCK_TOKEN" && a.address)
      .map((a) => ({ key: a.key, symbol: a.symbol, address: a.address!, decimals: a.decimals }));
  }

  private readonly chartCache = new TtlCache<PriceChartData>(() => this.now().getTime());

  /**
   * Price chart for a range. Stock Tokens: the underlying share's bars × on-chain multiplier, if
   * the latest bar agrees with the token's Chainlink price (else Chainlink). Others: Chainlink
   * rounds resampled to even buckets.
   */
  async getPriceChart(assetInput: string, range: ChartRange): Promise<PriceChartData | null> {
    const s = await this.snapshot();
    const { ref } = this.resolveAsset(s.ctx.registry, assetInput);
    if (!ref || !ref.canonical || !this.deps.prices) return null;
    const asset = s.ctx.registry.get(s.ctx.chainId, ref.address)!;
    return this.chartCache.getOrLoad(`${ref.key}:${range}`, CHART_TTL_MS[range], async () => {
      const now = this.now().getTime();
      const from = now - RANGE_MS[range];
      const generatedAt = this.now().toISOString();
      const p = (await priceCanonicalAssets(this.userCtx(s), [ref.key])).priceOf(ref.key);
      const price18 = p.price ? p.price.raw * 10n ** BigInt(18 - p.price.decimals) : null;
      let note: string | null = null;
      if (asset.type === "STOCK_TOKEN" && this.deps.shareHistory && p.multiplier && price18) {
        const symbol = asset.stockMetadata?.rhSymbol ?? asset.symbol;
        try {
          const pts = shareToToken(await this.deps.shareHistory(symbol, range), p.multiplier);
          const lastV = pts.at(-1)?.v;
          if (lastV && deviation(lastV, price18) <= MAX_DEVIATION) {
            // Share bars are already evenly spaced within trading sessions; the client spaces them by index.
            // Share data starting well after the range start means a later listing.
            const late = range !== "1D" && pts[0]!.t > from + 5 * 86_400_000 ? pts[0]!.t : null;
            const sum = summarize(range, pts, 18, late);
            const q = RH_QUERY[range];
            return { ...sum, source: { provider: "ROBINHOOD_MARKET_DATA" as const, symbol, multiplier: formatFixed(p.multiplier, 18), url: `${RH_MARKET_BASE}/${symbol}/?interval=${q.interval}&span=${q.span}` }, note: null, generatedAt };
          }
          note = lastV ? "SHARE_PRICE_MISMATCH" : "SHARE_DATA_EMPTY";
        } catch {
          note = "SHARE_DATA_UNAVAILABLE";
        }
      }
      const feed = await this.deps.prices!.feedFor(asset).catch(() => null);
      if (!feed || !this.deps.chartRounds) return { range, points: [], first: null, last: null, high: null, low: null, changePct: null, since: null, source: { provider: "CHAINLINK" as const, feed: "", proxy: "" }, note: note ?? "NO_FEED", generatedAt };
      const { decimals, rounds } = await this.deps.chartRounds.get(feed.proxyAddress, s.ctx.blockNumber);
      const rs = resample(rounds, from, now, BUCKET_MS[range]);
      const late = rounds.length && rounds[0]!.t > from ? rounds[0]!.t : null;
      return { ...summarize(range, rs, decimals, late), source: { provider: "CHAINLINK" as const, feed: feed.name, proxy: feed.proxyAddress }, note, generatedAt };
    });
  }

  // ---------------------------------------------------------------- coverage

  async getCoverage(): Promise<CoverageRow[]> {
    const t0 = performance.now();
    const s = await this.snapshot();
    const canonical = s.ctx.registry.canonical().filter((a) => a.address !== null);
    const priced = await priceCanonicalAssets(this.userCtx(s), canonical.map((a) => a.key));
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
