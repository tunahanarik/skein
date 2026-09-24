/**
 * Raw Opportunity / TradeRoute → ProductCard. Neutral labels only (never "best", "safe",
 * "guaranteed", "risk free"). All amounts stay bigint.
 */
import { classifyFreshness } from "../config/freshness.js";
import { formatPercent } from "../lib/fixed.js";
import { formatFixed, USD_DECIMALS } from "../lib/units.js";
import type { Opportunity, TokenAmount, UsdAmount, YieldMetric } from "../model/opportunity.js";
import type { TradeMarket, TradeQuote, TradeRoute } from "../model/trade.js";
import { headlineMetric } from "../opportunities/headline.js";
import { buildPortfolioOpportunity } from "../opportunities/userContext.js";
import type { PortfolioAsset } from "../portfolio/types.js";
import type { UsdPrice } from "../pricing/types.js";
import { classifyPriceImpact } from "../config/tradeQuality.js";
import { productCategoryOf } from "./categories.js";
import { opportunitySources, summarizeSources } from "./quality.js";
import type { BorrowCapacity, FixedYieldView, MetricView, ProductCard, TradeQuoteView, TradeRouteView, UsabilityResult } from "./types.js";
import { classifyOpportunity } from "./usability.js";

export function metricView(y: YieldMetric, nowS: number, unitOverride?: string | null): MetricView {
  const t = Math.floor(Date.parse(y.observedAt) / 1000);
  return {
    type: y.type,
    side: y.side,
    value: y.value,
    display: formatPercent(y.value, Math.abs(Number(y.value)) < 1e16 ? 4 : 2),
    basis: y.basis,
    origin: y.origin,
    observedAt: y.observedAt,
    // re-evaluated now: a cached projection must not look fresher than its source
    freshness: classifyFreshness(y.freshness.rule, Number.isFinite(t) ? t : null, nowS).status,
    label: y.label,
    unit: y.denominatedIn?.key ?? unitOverride ?? null,
  };
}

/** Unit for rates whose `denominatedIn` is null because they accrue in non-token accounting units. */
function accountingUnitOf(o: Opportunity): string | null {
  return o.details.kind === "PENDLE_MARKET" && o.details.accountingAsset ? `accounting:${o.details.accountingAsset.key}` : null;
}

export function opportunityCardId(o: Opportunity): string {
  const sub = productCategoryOf(o.category)?.subcategory ?? o.category;
  return `${o.protocol.id}:${sub}:${o.venue.kind}:${o.venue.id}:${o.primaryAsset.key}:${o.outputAssets[0]?.key ?? o.borrowAssets[0]?.key ?? "-"}`;
}

function actionFor(o: Opportunity): { actionLabel: string; context: string | null; counter: ProductCard["counterAsset"] } {
  const a = o.primaryAsset.symbol;
  const d = o.details;
  switch (o.category) {
    case "LEND":
      return { actionLabel: `Supply ${a}`, context: o.title, counter: null };
    case "VAULT":
      return { actionLabel: `Deposit ${a}`, context: d.kind === "MORPHO_VAULT_V2" ? `${o.protocol.name} vault "${d.name}"` : o.title, counter: null };
    case "COLLATERAL":
    case "BORROW": {
      const loan = o.borrowAssets[0] ?? null;
      return { actionLabel: `Borrow ${loan?.symbol ?? "?"} against ${a}`, context: o.title, counter: loan };
    }
    case "FIXED_YIELD":
      return { actionLabel: `Buy ${o.outputAssets[0]?.symbol ?? "PT"} with ${a}`, context: `${o.protocol.name}, matures ${o.lifecycle.maturity?.value.slice(0, 10) ?? "?"}`, counter: o.outputAssets[0] ?? null };
    case "YIELD":
      return { actionLabel: `Buy ${o.outputAssets[0]?.symbol ?? "YT"} with ${a}`, context: `${o.protocol.name}, yield exposure until ${o.lifecycle.maturity?.value.slice(0, 10) ?? "?"}`, counter: o.outputAssets[0] ?? null };
    case "LP":
      return { actionLabel: `Provide ${a} liquidity`, context: o.title, counter: o.outputAssets[0] ?? null };
    case "TRADE":
      return { actionLabel: `Trade ${a} → ${o.outputAssets[0]?.symbol ?? "?"}`, context: o.title, counter: o.outputAssets[0] ?? null };
  }
}

function fixedYieldView(o: Opportunity, nowS: number): FixedYieldView | undefined {
  if (o.category !== "FIXED_YIELD" || o.details.kind !== "PENDLE_MARKET") return undefined;
  const d = o.details;
  const implied = o.yields.find((y) => y.type === "IMPLIED_APY");
  const secs = o.lifecycle.secondsToMaturity;
  const claim = o.relationships.find((r) => r.kind === "REPRESENTS_CLAIM_ON");
  return {
    impliedApy: implied ? metricView(implied, nowS, accountingUnitOf(o)) : null,
    maturity: o.lifecycle.maturity?.value ?? null,
    secondsToMaturity: secs,
    daysToMaturity: secs === null ? null : (secs / 86_400).toFixed(1),
    accountingUnit: { assetType: d.accountingUnit.assetType, description: d.accountingUnit.description },
    ptDiscount: d.ptDiscount?.value ?? null,
    conditions: [
      "Market-implied rate at the last trade; realised only if bought at this price and held to maturity. Not guaranteed.",
      "The actual entry price includes swap fees and slippage.",
      ...(claim?.terms ? [`Redemption: ${claim.terms}`] : []),
    ],
  };
}

function borrowCapacity(o: Opportunity, row: PortfolioAsset | null, borrowPrice: UsdPrice | null): BorrowCapacity | undefined {
  if ((o.category !== "COLLATERAL" && o.category !== "BORROW") || !row || !o.liquidation) return undefined;
  const p = buildPortfolioOpportunity(o, row, borrowPrice);
  if (p.context.kind !== "COLLATERAL") return undefined;
  const c = p.context;
  return {
    kind: "THEORETICAL_LIMIT",
    recommendedBorrow: null,
    collateral: { amount: c.collateralHeld.amount!, usd: c.collateralHeld.usd },
    maxBorrow: c.protocolMaximumBorrow ? { asset: c.protocolMaximumBorrow.asset, amount: c.protocolMaximumBorrow.amount!, usd: c.protocolMaximumBorrow.usd } : null,
    lltv: o.liquidation.lltv.value,
    formula: c.formula,
    caveat: "THEORETICAL_LIMIT at the liquidation threshold: a position of this size is liquidatable on the next adverse move. Not a recommended amount; no safety buffer is modelled.",
    unavailableReason: c.unavailableReason,
    borrowableNow: borrowableNow(o, c.protocolMaximumBorrow),
  };
}

/** min(protocol limit, available market liquidity) in the loan asset; exact integer comparison. */
function borrowableNow(o: Opportunity, max: { amount: TokenAmount | null; usd: UsdAmount | null } | null): BorrowCapacity["borrowableNow"] {
  const limit = max?.amount ?? null;
  const liq = o.availableLiquidity?.value ?? null;
  if (!limit) return null;
  if (!liq?.amount || liq.amount.decimals !== limit.decimals) return { amount: limit, usd: max!.usd, cappedBy: "PROTOCOL_LIMIT" };
  return liq.amount.raw < limit.raw ? { amount: liq.amount, usd: liq.usd, cappedBy: "MARKET_LIQUIDITY" } : { amount: limit, usd: max!.usd, cappedBy: "PROTOCOL_LIMIT" };
}

export interface CardContext {
  nowS: number;
  holding: PortfolioAsset | null;
  borrowPriceOf: (assetKey: string) => UsdPrice | null;
}

export function opportunityCard(o: Opportunity, ctx: CardContext, usability: UsabilityResult = classifyOpportunity(o)): ProductCard {
  const pc = productCategoryOf(o.category)!;
  const a = actionFor(o);
  const h = headlineMetric(o);
  const unit = accountingUnitOf(o);
  const metrics = o.yields.map((y) => metricView(y, ctx.nowS, unit));
  const observed = [...o.yields.map((y) => y.observedAt), o.availableLiquidity?.observedAt, o.tvl?.observedAt].filter((x): x is string => !!x).sort();
  const worst = o.freshness.status;
  const card: ProductCard = {
    cardId: opportunityCardId(o),
    category: pc.category,
    subcategory: pc.subcategory,
    rawCategory: o.category,
    protocol: { ...o.protocol },
    actionLabel: a.actionLabel,
    context: a.context,
    asset: o.primaryAsset,
    counterAsset: a.counter,
    headline: h ? metricView(h, ctx.nowS, unit) : null,
    metrics,
    liquidity: o.availableLiquidity ? { kind: o.liquidityKind ?? "UNKNOWN", usd: o.availableLiquidity.value.usd } : null,
    tvlUsd: o.tvl?.value.usd ?? null,
    maturity: o.lifecycle.maturity?.value ?? null,
    lltv: o.liquidation?.lltv.value ?? null,
    usability,
    verification: o.verificationStatus,
    freshness: { status: worst, oldestObservedAt: observed[0] ?? null },
    sources: summarizeSources(opportunitySources(o)),
    ranking: null,
    sourceOpportunityIds: [o.id],
  };
  const bc = borrowCapacity(o, ctx.holding, o.borrowAssets[0] ? ctx.borrowPriceOf(o.borrowAssets[0].key) : null);
  if (bc) card.borrowCapacity = bc;
  const fy = fixedYieldView(o, ctx.nowS);
  if (fy) card.fixedYield = fy;
  return card;
}

export function routeView(route: TradeRoute, markets: ReadonlyMap<string, TradeMarket>): TradeRouteView {
  return {
    routeId: route.id,
    kind: route.kind,
    path: [route.input, ...route.intermediates, route.output],
    markets: route.hops.map((h) => {
      const m = markets.get(h.marketId);
      return { marketId: h.marketId, protocol: m?.protocol.name ?? "?", feePpm: h.fee?.ppm ?? null, tvlUsd: m?.liquidity.tvl?.value ?? null };
    }),
    combinedFeePpm: route.properties.combinedFeePpm,
    routeLiquidityUsd: route.properties.bottleneckTvlUsd,
    allVerified: route.properties.allMarketsVerified,
    volume24h: "UNKNOWN",
  };
}

export function quoteView(q: TradeQuote, nowS: number): TradeQuoteView {
  const blockTs = Math.floor(Date.parse(q.quotedAt) / 1000);
  return {
    kind: "INDICATIVE_QUOTE",
    input: q.input,
    expectedOutput: q.expectedOutput,
    effectivePrice: q.effectivePrice,
    priceImpact: q.priceImpact,
    priceImpactClass: classifyPriceImpact(q.priceImpact),
    fees: q.fees?.map((f) => ({ asset: f.asset, amount: f.amount })) ?? null,
    blockNumber: q.blockNumber,
    quotedAt: q.quotedAt,
    freshness: classifyFreshness(q.freshness.rule, Number.isFinite(blockTs) ? blockTs : null, nowS).status,
    guarantee: "NONE",
  };
}

/** `lookup.hopOpportunities`: `${marketId}|${fromKey}` → the raw TRADE opportunity id for that hop direction. */
export function routeCard(route: TradeRoute, lookup: { markets: ReadonlyMap<string, TradeMarket>; hopOpportunities: ReadonlyMap<string, string> }, usability: UsabilityResult, quote: { q: TradeQuote; nowS: number } | null, quoteUnavailableReason?: string): ProductCard {
  const ms = route.hops.map((h) => lookup.markets.get(h.marketId)).filter((m): m is TradeMarket => !!m);
  const protocols = [...new Set(ms.map((m) => m.protocol.name))];
  const sources = summarizeSources([...ms.flatMap((m) => m.provenance), ...(quote ? [quote.q.source] : [])]);
  const path = [route.input, ...route.intermediates, route.output].map((a) => a.symbol).join(" → ");
  const card: ProductCard = {
    cardId: `route:${route.id}`,
    category: "TRADE",
    subcategory: "TRADE",
    rawCategory: "TRADE_ROUTE",
    protocol: { id: ms[0]?.protocol.id ?? "?", name: protocols.join(" + ") || "?" },
    actionLabel: `Trade ${route.input.symbol} → ${route.output.symbol}`,
    context: `${route.kind === "DIRECT" ? "Direct" : "One hop"}: ${path}`,
    asset: route.input,
    counterAsset: route.output,
    headline: null,
    metrics: [],
    liquidity: { kind: "ROUTE_BOTTLENECK_TVL", usd: route.properties.bottleneckTvlUsd },
    tvlUsd: route.properties.bottleneckTvlUsd,
    maturity: null,
    lltv: null,
    usability,
    verification: route.properties.allMarketsVerified ? "VERIFIED_ONCHAIN" : "UNVERIFIED",
    freshness: { status: ms.map((m) => m.freshness.status).sort((a, b) => ["FRESH", "AGING", "STALE", "UNKNOWN"].indexOf(b) - ["FRESH", "AGING", "STALE", "UNKNOWN"].indexOf(a))[0] ?? "UNKNOWN", oldestObservedAt: null },
    sources,
    ranking: null,
    trade: { route: routeView(route, lookup.markets), quote: quote ? quoteView(quote.q, quote.nowS) : null, ...(quoteUnavailableReason ? { quoteUnavailableReason } : {}) },
    // The raw TRADE opportunity of every hop (market + direction); RAW mode ids.
    sourceOpportunityIds: route.hops.map((h) => lookup.hopOpportunities.get(`${h.marketId}|${h.from.key}`) ?? h.marketId),
  };
  return card;
}

export const usdDisplay = (e18: bigint | null | undefined) => (e18 === null || e18 === undefined ? null : formatFixed(e18, USD_DECIMALS));
