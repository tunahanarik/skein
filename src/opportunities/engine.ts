/**
 * Opportunity Engine: fans out to protocol adapters, isolates their failures, merges and
 * de-duplicates results, and applies generic filters/sorting. It contains NO protocol-specific
 * logic — adding a protocol means adding an adapter, not editing this file.
 */
import type { Address } from "viem";
import { ROBINHOOD_CHAIN_ID } from "../config/chains.js";
import type { ChainReader } from "../chain/reader.js";
import type { EligibilityReason, Opportunity } from "../model/opportunity.js";
import type { Position } from "../model/position.js";
import { warn, type Warning } from "../model/warnings.js";
import type { PriceService } from "../pricing/priceService.js";
import type { Portfolio } from "../portfolio/types.js";
import type { AssetRegistry } from "../registry/registry.js";
import { parseWalletAddress } from "../lib/validation.js";
import { combineStatus, type AdapterContext, type AdapterIssue, type AdapterResult, type OpportunityAdapter, type ResultStatus } from "./adapter.js";
import { filterOpportunities, sortOpportunities, type OpportunityFilter, type SortSpec } from "./query.js";
import { buildPortfolioOpportunity, type PortfolioOpportunity } from "./userContext.js";
import { computeEligibility, passesEligibility } from "./eligibility.js";
import { DEFAULT_ELIGIBILITY_POLICY, type EligibilityPolicy } from "../config/eligibility.js";
import { QUOTE_TIMEOUT_MS } from "../config/freshness.js";
import type { QuoteResult, TradeMarket, TradeRoute } from "../model/trade.js";
import { buildTradeGraph, destinations, findRoutes, type EdgeRejection, type RouteSearch } from "../trade/graph.js";

export interface EngineDeps {
  reader: ChainReader;
  getRegistry: () => Promise<AssetRegistry>;
  prices: PriceService;
  now?: () => Date;
  eligibilityPolicy?: EligibilityPolicy;
  /** Override of QUOTE_TIMEOUT_MS (tests). */
  quoteTimeoutMs?: number;
}

export interface AdapterRunSummary {
  protocol: string;
  status: ResultStatus;
  issues: AdapterIssue[];
  itemCount: number;
  timingsMs: Record<string, number>;
}

export interface EngineResult<T> {
  data: T;
  status: ResultStatus;
  adapters: AdapterRunSummary[];
  warnings: Warning[];
  chainId: number;
  blockNumber: bigint;
  generatedAt: string;
  timingsMs: { total: number };
  /** Opportunity ids that the requested sort could not rank (no comparable metric). */
  notComparable?: string[];
  /**
   * Discovered opportunities NOT shown because of the eligibility policy, counted per excluding
   * reason (one opportunity can count under several). Never deleted: query with
   * eligibility "ALL" or includeReasons to see them.
   */
  excluded?: { total: number; byReason: Partial<Record<EligibilityReason, number>> };
}

export interface OpportunityQuery {
  filter?: OpportunityFilter;
  sort?: SortSpec;
  /** Default ELIGIBLE_ONLY: the default user-facing view. ALL: debug / full discovery. */
  eligibility?: "ELIGIBLE_ONLY" | "ALL";
  /** Re-admit opportunities whose only excluding reasons are these (e.g. ["EXPIRED"]). */
  includeReasons?: readonly EligibilityReason[];
}

const elapsed = (t: number) => Math.round(performance.now() - t);

export class OpportunityEngine {
  private readonly now: () => Date;
  private readonly policy: EligibilityPolicy;

  constructor(
    private readonly adapters: readonly OpportunityAdapter[],
    private readonly deps: EngineDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    this.policy = deps.eligibilityPolicy ?? DEFAULT_ELIGIBILITY_POLICY;
    const ids = adapters.map((a) => a.protocol.id);
    if (new Set(ids).size !== ids.length) throw new Error(`duplicate adapter protocol ids: ${ids.join(", ")}`);
  }

  async context(): Promise<AdapterContext> {
    const [registry, block] = await Promise.all([this.deps.getRegistry(), this.deps.reader.getLatestBlock()]);
    return { chainId: ROBINHOOD_CHAIN_ID, reader: this.deps.reader, registry, prices: this.deps.prices, now: this.now, blockNumber: block.number, blockTimestamp: block.timestamp };
  }

  /** Run one adapter call with failure isolation: a throw becomes an UNKNOWN result. */
  private async run<T>(a: OpportunityAdapter, empty: T, call: () => Promise<AdapterResult<T>> | undefined): Promise<AdapterResult<T> & { protocol: string }> {
    const t = performance.now();
    try {
      const p = call();
      if (!p) return { protocol: a.protocol.id, data: empty, status: "UNKNOWN", issues: [{ scope: a.protocol.id, message: "capability not supported", severity: "FATAL" }], warnings: [], timingsMs: {} };
      const r = await p;
      return { ...r, protocol: a.protocol.id, timingsMs: { ...r.timingsMs, total: elapsed(t) } };
    } catch (e) {
      return {
        protocol: a.protocol.id,
        data: empty,
        status: "UNKNOWN",
        issues: [{ scope: a.protocol.id, message: (e as Error).message?.split("\n")[0] ?? "adapter failed", severity: "FATAL" }],
        warnings: [warn("ADAPTER_FAILED", `${a.protocol.name} adapter failed: ${(e as Error).message?.split("\n")[0]}`)],
        timingsMs: { total: elapsed(t) },
      };
    }
  }

  private merge(results: (AdapterResult<Opportunity[]> & { protocol: string })[], ctx: AdapterContext, t0: number, query: OpportunityQuery): EngineResult<Opportunity[]> {
    const warnings: Warning[] = [];
    const seen = new Map<string, Opportunity>();
    for (const r of results) {
      warnings.push(...r.warnings);
      if (r.status === "PARTIAL") warnings.push(warn("ADAPTER_DEGRADED", `${r.protocol}: partial results (${r.issues.length} issues)`));
      for (const o of r.data) {
        if (seen.has(o.id)) {
          warnings.push(warn("DUPLICATE_OPPORTUNITY_ID", `duplicate opportunity id ${o.id} from ${r.protocol}; first kept`));
          continue;
        }
        const eligibility = computeEligibility(o, this.policy);
        // Generic advisory surfaced as a warning too (threshold: the eligibility policy).
        const low = eligibility.advisories.includes("LOW_LIQUIDITY") && !o.warnings.some((w) => w.code === "LOW_LIQUIDITY");
        seen.set(o.id, { ...o, eligibility, ...(low ? { warnings: [...o.warnings, warn("LOW_LIQUIDITY", `available liquidity ${o.availableLiquidity?.value.usd?.display ?? "?"} USD is below the ${this.policy.id} display threshold`)] } : {}) });
      }
    }
    const filtered = filterOpportunities([...seen.values()], query.filter);
    const mode = query.eligibility ?? "ELIGIBLE_ONLY";
    let data: Opportunity[] = [];
    const byReason: Partial<Record<EligibilityReason, number>> = {};
    let excludedTotal = 0;
    for (const o of filtered) {
      if (passesEligibility(o.eligibility!, mode, query.includeReasons)) data.push(o);
      else {
        excludedTotal++;
        for (const r of o.eligibility!.excludedBy) byReason[r] = (byReason[r] ?? 0) + 1;
      }
    }
    let notComparable: string[] | undefined;
    if (query.sort) {
      const s = sortOpportunities(data, query.sort);
      data = s.sorted;
      notComparable = s.notComparable;
    } else data.sort((a, b) => a.id.localeCompare(b.id));
    return {
      data,
      status: combineStatus(results.map((r) => r.status)),
      adapters: results.map((r) => ({ protocol: r.protocol, status: r.status, issues: r.issues, itemCount: r.data.length, timingsMs: r.timingsMs })),
      warnings,
      chainId: ROBINHOOD_CHAIN_ID,
      blockNumber: ctx.blockNumber,
      generatedAt: this.now().toISOString(),
      timingsMs: { total: elapsed(t0) },
      ...(notComparable ? { notComparable } : {}),
      excluded: { total: excludedTotal, byReason },
    };
  }

  async getOpportunities(query: OpportunityQuery = {}, ctx?: AdapterContext): Promise<EngineResult<Opportunity[]>> {
    const t0 = performance.now();
    const c = ctx ?? (await this.context());
    const results = await Promise.all(this.adapters.filter((a) => a.capabilities.discovery).map((a) => this.run(a, [] as Opportunity[], () => a.getOpportunities?.(c))));
    return this.merge(results, c, t0, query);
  }

  /** Opportunities a holder of `assetKey` can take (asset is the PRIMARY asset). */
  async getAssetOpportunities(assetKey: string, query: OpportunityQuery = {}, ctx?: AdapterContext): Promise<EngineResult<Opportunity[]>> {
    const t0 = performance.now();
    const c = ctx ?? (await this.context());
    const results = await Promise.all(
      this.adapters.map((a) =>
        this.run(a, [] as Opportunity[], () =>
          a.capabilities.assetFiltering ? a.getAssetOpportunities?.(assetKey, c) : a.capabilities.discovery ? a.getOpportunities?.(c) : undefined,
        ),
      ),
    );
    return this.merge(results, c, t0, { ...query, filter: { ...query.filter, assetKey, assetRole: query.filter?.assetRole ?? "PRIMARY" } });
  }

  async getUserPositions(walletInput: unknown, ctx?: AdapterContext): Promise<EngineResult<Position[]>> {
    const t0 = performance.now();
    const wallet: Address = parseWalletAddress(walletInput);
    const c = ctx ?? (await this.context());
    const results = await Promise.all(this.adapters.filter((a) => a.capabilities.userPositions).map((a) => this.run(a, [] as Position[], () => a.getUserPositions?.(wallet, c))));
    const data = results.flatMap((r) => r.data).sort((a, b) => a.id.localeCompare(b.id));
    return {
      data,
      status: combineStatus(results.map((r) => r.status)),
      adapters: results.map((r) => ({ protocol: r.protocol, status: r.status, issues: r.issues, itemCount: r.data.length, timingsMs: r.timingsMs })),
      warnings: results.flatMap((r) => r.warnings),
      chainId: ROBINHOOD_CHAIN_ID,
      blockNumber: c.blockNumber,
      generatedAt: this.now().toISOString(),
      timingsMs: { total: elapsed(t0) },
    };
  }

  /**
   * For every canonical asset the portfolio holds, the opportunities where it is the primary
   * asset, with user-aware context. One discovery run is shared across all held assets.
   */
  // ---- trade (Phase 4): generic over any adapter that publishes TRADE opportunities ----

  /** Every market behind a TRADE opportunity, from all adapters (full discovery, not only eligible). */
  async getTradeMarkets(ctx?: AdapterContext): Promise<EngineResult<TradeMarket[]>> {
    const t0 = performance.now();
    const r = await this.getOpportunities({ eligibility: "ALL", filter: { categories: ["TRADE"] } }, ctx);
    const seen = new Map<string, TradeMarket>();
    for (const o of r.data) if (o.trade && !seen.has(o.trade.market.id)) seen.set(o.trade.market.id, o.trade.market);
    return { ...r, data: [...seen.values()].sort((a, b) => a.id.localeCompare(b.id)), timingsMs: { total: elapsed(t0) } };
  }

  /** DIRECT and ONE_HOP routes between two registry keys, built from verified markets only. */
  async getTradeRoutes(inputKey: string, outputKey: string, ctx?: AdapterContext): Promise<EngineResult<RouteSearch & { edges: number; rejected: EdgeRejection[]; graphMs: number }>> {
    const c = ctx ?? (await this.context());
    const markets = await this.getTradeMarkets(c);
    const tg = performance.now();
    const graph = buildTradeGraph(markets.data);
    const routes = findRoutes(graph, inputKey, outputKey);
    return { ...markets, data: { ...routes, edges: graph.markets.size, rejected: graph.rejected, graphMs: elapsed(tg) } };
  }

  /**
   * INDICATIVE quote for one route and an explicit input amount. Routed to the single adapter that
   * owns every market of the route; multi-venue routes are not quoted. Bounded by QUOTE_TIMEOUT_MS.
   */
  async getTradeQuote(route: TradeRoute, amountInRaw: bigint, ctx?: AdapterContext): Promise<QuoteResult> {
    if (amountInRaw <= 0n) return { ok: false, reason: "amount must be positive", retryable: false };
    if (route.properties.protocols.length !== 1) return { ok: false, reason: "routes across several venues are not quoted", retryable: false };
    const a = this.adapters.find((x) => x.protocol.id === route.properties.protocols[0]);
    if (!a || !a.capabilities.quotes || !a.quoteRoute) return { ok: false, reason: `${route.properties.protocols[0]} does not provide quotes`, retryable: false };
    const c = ctx ?? (await this.context());
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        a.quoteRoute(route, amountInRaw, c),
        new Promise<QuoteResult>((resolve) => {
          const limit = this.deps.quoteTimeoutMs ?? QUOTE_TIMEOUT_MS;
          timer = setTimeout(() => resolve({ ok: false, reason: `quote timed out after ${limit} ms`, retryable: true }), limit);
        }),
      ]);
    } catch (e) {
      return { ok: false, reason: `quote failed: ${(e as Error).message?.split("\n")[0] ?? "error"}`, retryable: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getPortfolioOpportunities(portfolio: Portfolio, query: OpportunityQuery = {}): Promise<EngineResult<{ assetKey: string; items: PortfolioOpportunity[]; tradeDestinations: { direct: string[]; oneHop: string[] } }[]>> {
    const t0 = performance.now();
    const ctx = await this.context();
    const { sort: _sort, ...rest } = query;
    const all = await this.getOpportunities(rest, ctx);
    const held = portfolio.assets.filter((r) => r.asset.canonical && r.balanceStatus === "OK" && (r.rawBalance ?? 0n) > 0n && r.asset.address !== null);

    // Price every borrow asset once via the Phase 1 Price Service (no protocol prices).
    const borrowKeys = [...new Set(all.data.flatMap((o) => o.borrowAssets.map((b) => b.key)))];
    const borrowAssets = borrowKeys.map((k) => ctx.registry.assets.find((a) => a.key === k)).filter((a): a is NonNullable<typeof a> => !!a && a.canonical);
    const priced = borrowAssets.length ? await ctx.prices.priceAssets(borrowAssets.map((asset) => ({ asset })), { blockNumber: ctx.blockNumber }) : null;

    // Trade destinations from the generic graph (eligible TRADE markets only). No quotes: an
    // amount-specific quote requires an explicit amount, never the whole balance.
    const graph = buildTradeGraph(all.data.flatMap((o) => (o.trade ? [o.trade.market] : [])));
    const groups = held.map((row) => {
      let items = all.data.filter((o) => o.primaryAsset.key === row.asset.key);
      if (query.sort) items = sortOpportunities(items, query.sort).sorted;
      return {
        assetKey: row.asset.key,
        tradeDestinations: destinations(graph, row.asset.key),
        items: items.map((o) => {
          const b = o.borrowAssets[0];
          const q = b ? priced?.quotes.get(b.key) : undefined;
          return buildPortfolioOpportunity(o, row, q?.status === "PRICED" ? q.priceUsd : null);
        }),
      };
    });
    return { ...all, data: groups, timingsMs: { total: elapsed(t0) }, warnings: [...all.warnings, ...(priced?.warnings ?? [])] };
  }
}
