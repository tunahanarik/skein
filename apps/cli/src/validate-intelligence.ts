/**
 * Phase 5 live validation (read-only) of the product read API over live Morpho + Pendle + Uniswap:
 * NVDA, USDG, another Stock Token (TSLA) and a sparse asset (fewest discovered opportunities);
 * projection vs raw engine output; default filter; neutral labels; ranking consistency; trade
 * display (routes, per-target cap, explicit-amount quotes and impact classes); portfolio
 * intelligence on one discovered public holder (address redacted, never printed or stored);
 * coverage; controlled adapter outages at the service level; performance.
 */
import type { Address } from "viem";
import { CORE_ASSETS } from "@skein/robinhood/config/assets";
import { PRODUCT_MAX_ROUTES_PER_TARGET } from "@skein/robinhood/config/trade";
import { classifyPriceImpact, TRADE_QUALITY_POLICY } from "@skein/core/config/tradeQuality";
import { OpportunityEngine } from "@skein/engine/opportunities/engine";
import type { OpportunityAdapter } from "@skein/engine/opportunities/adapter";
import { AssetIntelligenceService } from "@skein/product/service";
import type { AssetIntelligence } from "@skein/product/types";
import { MorphoAdapter } from "@skein/protocols/morpho/adapter";
import { PendleAdapter } from "@skein/protocols/pendle/adapter";
import { UniswapAdapter } from "@skein/protocols/uniswap/adapter";
import { FilePoolListStore } from "@skein/protocols/uniswap/poolStore";
import { createRuntime, UNISWAP_POOL_CACHE_PATH, type Runtime } from "@skein/runtime/runtime";
import { Report } from "./lib/report.js";
import { discoverHolders, redact } from "./validate-portfolio.js";

const NVDA: Address = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const K = (a: string) => `4663:${a.toLowerCase()}`;
const USDG_KEY = K(CORE_ASSETS.USDG.address);
const WETH_KEY = K(CORE_ASSETS.WETH.address);
const FORBIDDEN = /\bbest\b|safest|\bsafe\b|(?<!not[ _]|not a )guaranteed|risk[ -]?free|(?<!not |not a )recommended(?!Borrow)/i;
const VISIBLE = new Set(["ACTIONABLE", "LIMITED", "INFORMATIONAL"]);
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const cardsOf = (v: AssetIntelligence) => v.categories.flatMap((c) => c.subcategories.flatMap((s) => s.cards));
const ms = (t: number) => Math.round(performance.now() - t);

let shared: Runtime | null = null;
const runtime = () => (shared ??= createRuntime());

/** Structural checks every AssetIntelligence must pass. Returns problems (empty = OK). */
function structural(v: AssetIntelligence, rawIds: Set<string>): string[] {
  const p: string[] = [];
  const n = v.summary.counts;
  if (n.actionable + n.limited + n.informational + n.hidden + n.unavailable !== n.discovered) p.push("counts do not add up");
  const order = ["TRADE", "EARN", "BORROW", "LIQUIDITY"];
  const cats = v.categories.map((c) => c.category);
  if (cats.join() !== order.filter((c) => cats.includes(c as never)).join()) p.push("category order");
  for (const c of v.categories)
    for (const s of c.subcategories) {
      if (s.cards.some((x) => x.subcategory !== s.subcategory || x.category !== c.category)) p.push(`mixed cards in ${s.subcategory}`);
      const groups = new Map<string, number[]>();
      for (const x of s.cards) groups.set(x.ranking?.context?.target ?? "-", [...(groups.get(x.ranking?.context?.target ?? "-") ?? []), x.ranking?.position ?? -1]);
      for (const [g, ps] of groups) if (ps.join() !== ps.map((_, i) => i + 1).join()) p.push(`positions ${s.subcategory}/${g}`);
      if (s.subcategory === "TRADE" && v.mode === "PRODUCT") for (const [g, ps] of groups) if (ps.length > PRODUCT_MAX_ROUTES_PER_TARGET) p.push(`route cap exceeded for ${g}`);
    }
  for (const c of cardsOf(v)) {
    if (!VISIBLE.has(c.usability.status)) p.push(`hidden card visible: ${c.cardId}`);
    for (const id of c.sourceOpportunityIds) if (!rawIds.has(id)) p.push(`card ${c.cardId} cites unknown raw id`);
    if (c.subcategory === "YIELD" && c.asset.registryType === "STOCK_TOKEN") p.push("Stock Token YT visible (P3-1)");
    if (c.trade?.route && (c.trade.route.routeLiquidityUsd?.e18 ?? 0n) < TRADE_QUALITY_POLICY.minActionableRouteTvlUsdE18 && c.usability.status === "ACTIONABLE") p.push(`thin route ACTIONABLE: ${c.cardId}`);
  }
  const ids = [...cardsOf(v), ...(v.excluded ?? [])].map((c) => c.cardId);
  if (new Set(ids).size !== ids.length) p.push("duplicate cardIds");
  if (FORBIDDEN.test(json(v))) p.push("forbidden label wording");
  return p;
}

export async function validateIntelligence(report = new Report("intelligence-validation")) {
  const rt = runtime();
  await rt.reader.assertChainId();
  const svc = rt.intelligence;
  const registry = await rt.getRegistry();
  const bySym = (s: string) => registry.canonicalBySymbol(s)[0]!.key;

  // ---- raw engine output (the source of truth) ----
  let t = performance.now();
  const raw = await svc.getRawOpportunities({ eligibility: "ALL" });
  report.info("raw engine", `${raw.data.length} raw opportunities in ${ms(t)} ms; adapters ${raw.adapters.map((a) => `${a.protocol}:${a.status}`).join(", ")}`);
  const rawIds = new Set(raw.data.map((o) => o.id));

  // ---- NVDA (cold then warm), DEBUG, quoted ----
  t = performance.now();
  const nvda = await svc.getAssetIntelligence(NVDA);
  const nvdaCold = ms(t);
  t = performance.now();
  await svc.getAssetIntelligence(NVDA);
  const nvdaWarm = ms(t);
  const sNvda = structural(nvda, rawIds);
  report.add(sNvda.length ? "FAIL" : "PASS", "NVDA structure", sNvda.length ? sNvda.slice(0, 5).join("; ") : `${cardsOf(nvda).length} product cards, capabilities ${json(nvda.summary.capabilities.detail)}, quality ${nvda.dataQuality.status}`);
  const rawNvda = raw.data.filter((o) => o.primaryAsset.key === K(NVDA));
  report.add(nvda.summary.counts.discovered === rawNvda.length ? "PASS" : "FAIL", "NVDA counts == raw", `discovered ${nvda.summary.counts.discovered} vs raw ${rawNvda.length}; verified ${nvda.summary.counts.verified}, actionable ${nvda.summary.counts.actionable}, limited ${nvda.summary.counts.limited}, hidden ${nvda.summary.counts.hidden}`);
  report.add(nvda.price?.usd && nvda.price.kind === "PORTFOLIO_PRICE" ? "PASS" : "FAIL", "NVDA price", `${nvda.price?.usd} via ${nvda.price?.method} (${nvda.price?.freshness})`);
  const trade = nvda.categories.find((c) => c.category === "TRADE")?.subcategories[0];
  const targets = new Set(trade?.cards.map((c) => c.ranking?.context?.target));
  report.add(trade && targets.has(USDG_KEY) && targets.has(WETH_KEY) && trade.cards.every((c) => c.trade?.quote === null) ? "PASS" : "FAIL", "NVDA default trade targets", `routes (no quotes) to USDG and WETH; shown ${trade?.cards.length}; moreRoutes ${json(trade?.moreRoutes ?? [])}; other destinations ${json(nvda.otherTradeDestinations)}`);
  const pt = nvda.categories.flatMap((c) => c.subcategories).find((s) => s.subcategory === "FIXED_YIELD")?.cards[0];
  report.add(!pt || (pt.fixedYield?.maturity && pt.fixedYield.accountingUnit && pt.fixedYield.conditions.some((x) => /not guaranteed/i.test(x))) ? "PASS" : "FAIL", "NVDA PT display", pt ? `${pt.actionLabel}: ${pt.headline?.display} implied, maturity ${pt.fixedYield?.maturity}, unit ${pt.fixedYield?.accountingUnit.assetType}` : "no visible PT");

  const dbg = await svc.getAssetIntelligence(NVDA, { mode: "DEBUG" });
  const excludedReasons = new Set(dbg.excluded?.flatMap((c) => c.usability.reasons));
  report.add(dbg.excluded?.every((c) => !VISIBLE.has(c.usability.status) && c.usability.reasons.length > 0) ? "PASS" : "FAIL", "NVDA DEBUG exclusions explained", `${dbg.excluded?.length} excluded; reasons ${[...excludedReasons].join(", ")}`);

  t = performance.now();
  const q = await svc.getAssetIntelligence(NVDA, { tradeTarget: USDG_KEY, tradeAmount: "1" });
  const quotedMs = ms(t);
  const qc = q.categories.find((c) => c.category === "TRADE")?.subcategories[0]?.cards ?? [];
  const outs = qc.map((c) => c.trade?.quote?.expectedOutput.raw ?? -1n);
  const monotone = outs.every((o, i) => i === 0 || outs[i - 1]! >= o);
  const classOk = qc.every((c) => c.trade?.quote && c.trade.quote.priceImpactClass === classifyPriceImpact(c.trade.quote.priceImpact) && c.trade.quote.guarantee === "NONE");
  report.add(qc.length && monotone && classOk ? "PASS" : "FAIL", "NVDA→USDG 1 quoted ranking", `${qc.length} quoted routes, TRADE_QUOTE_V1 by expected output; top ${qc[0]?.trade?.quote?.expectedOutput.display} USDG impact ${qc[0]?.trade?.quote?.priceImpactClass}; classes ${[...new Set(qc.map((c) => c.trade?.quote?.priceImpactClass))].join(",")}`);
  const qd = await svc.getAssetIntelligence(NVDA, { mode: "DEBUG", tradeTarget: USDG_KEY, tradeAmount: "1" });
  const extremeVisible = [...cardsOf(qd)].some((c) => c.trade?.quote?.priceImpactClass === "EXTREME");
  const extremeHidden = (qd.excluded ?? []).filter((c) => c.trade?.quote?.priceImpactClass === "EXTREME").length;
  report.add(extremeVisible ? "FAIL" : "PASS", "EXTREME impact never visible", `${extremeHidden} EXTREME-impact route(s) hidden by default at 1 NVDA`);

  // ---- USDG ----
  t = performance.now();
  const usdg = await svc.getAssetIntelligence(USDG_KEY);
  const usdgMs = ms(t);
  const sUsdg = structural(usdg, rawIds);
  report.add(sUsdg.length ? "FAIL" : "PASS", "USDG structure", sUsdg.length ? sUsdg.slice(0, 5).join("; ") : `${cardsOf(usdg).length} product cards, capabilities ${json(usdg.summary.capabilities.detail)}`);
  const lend = usdg.categories.flatMap((c) => c.subcategories).find((s) => s.subcategory === "LEND")?.cards ?? [];
  const act = lend.filter((c) => c.usability.status === "ACTIONABLE").map((c) => c.headline?.value ?? -1n);
  report.add(act.every((v, i) => i === 0 || act[i - 1]! >= v) ? "PASS" : "FAIL", "USDG LEND ordering", `${lend.length} lend cards; actionable ordered by SUPPLY_APY desc (${lend.slice(0, 3).map((c) => c.headline?.display).join(", ")} …)`);
  const leaked = cardsOf(usdg).filter((c) => c.usability.reasons.some((r) => ["EXPIRED", "DEPOSIT_DISABLED", "DATA_CONFLICT", "DUST_LIQUIDITY", "NON_CANONICAL_ASSET"].includes(r)));
  report.add(leaked.length ? "FAIL" : "PASS", "USDG default filter", `${leaked.length} expired/disabled/conflicted/dust/non-canonical items visible (expect 0)`);

  // ---- another Stock Token and a sparse asset ----
  const tsla = await svc.getAssetIntelligence(bySym("TSLA"));
  const sTsla = structural(tsla, rawIds);
  report.add(sTsla.length ? "FAIL" : "PASS", "TSLA structure", sTsla.length ? sTsla.join("; ") : `capabilities ${json(tsla.summary.capabilities.detail)}; counts ${json({ d: tsla.summary.counts.discovered, a: tsla.summary.counts.actionable, l: tsla.summary.counts.limited })}`);
  t = performance.now();
  const coverage = await svc.getCoverage();
  const coverageMs = ms(t);
  const stocks = coverage.filter((r) => r.asset.registryType === "STOCK_TOKEN");
  const sparseRow = [...stocks].sort((a, b) => a.actionable + a.limited + a.hidden + a.unavailable + a.informational - (b.actionable + b.limited + b.hidden + b.unavailable + b.informational) || a.asset.symbol.localeCompare(b.asset.symbol))[0]!;
  const sparse = await svc.getAssetIntelligence(sparseRow.asset.key);
  const sSparse = structural(sparse, rawIds);
  report.add(!sSparse.length && (cardsOf(sparse).length > 0 || sparse.emptyStates.some((e) => e === "NO_OPPORTUNITIES" || e === "NO_USABLE_OPPORTUNITIES")) ? "PASS" : "FAIL", "sparse asset", `${sparseRow.asset.symbol}: ${cardsOf(sparse).length} cards, empty states ${sparse.emptyStates.join(",") || "—"}, capabilities ${json(sparse.summary.capabilities.detail)}`);

  // ---- coverage ----
  const canonical = registry.canonical().filter((a) => a.address).length;
  const covVsView = [nvda, usdg, tsla].every((v) => {
    const row = coverage.find((r) => r.asset.key === v.asset!.key)!;
    return (["EARN", "BORROW", "LIQUIDITY"] as const).every((c) => row.capabilities.detail[c] === v.summary.capabilities.detail[c]);
  });
  report.add(coverage.length === canonical && covVsView ? "PASS" : "FAIL", "coverage matrix", `${coverage.length}/${canonical} canonical assets; actionable intents — trade ${coverage.filter((r) => r.capabilities.canTrade).length}, earn ${coverage.filter((r) => r.capabilities.canEarn).length}, borrow ${coverage.filter((r) => r.capabilities.canBorrowAgainst).length}, liquidity ${coverage.filter((r) => r.capabilities.canProvideLiquidity).length}; EARN/BORROW/LIQUIDITY agree with asset views: ${covVsView}`);

  // ---- portfolio intelligence (one discovered public NVDA holder; redacted) ----
  // Holder discovery uses raw getCode calls; on the public RPC one pause-and-retry absorbs a 429 burst.
  const findHolder = () => discoverHolders(rt.rpc.url, NVDA as Address, 1);
  const holders = await findHolder().catch(async () => {
    await new Promise((r) => setTimeout(r, 10_000));
    return findHolder().catch(() => [] as Address[]);
  });
  if (!holders.length) report.warn("portfolio intelligence", "no recent public NVDA holder found in the scan window");
  else {
    const w = holders[0]!;
    t = performance.now();
    const p = await svc.getPortfolioIntelligence(w);
    const portfolioMs = ms(t);
    const problems = p.assets.flatMap((a) => structural(a, rawIds));
    const autoQuoted = p.assets.some((a) => cardsOf(a).some((c) => c.trade?.quote));
    const metricsText = json(svc.metrics.snapshot());
    const leaks = metricsText.toLowerCase().includes(w.slice(2).toLowerCase());
    report.add(!problems.length && !autoQuoted && !leaks ? "PASS" : "FAIL", "portfolio intelligence", `${redact(w)}: ${p.assets.length} held canonical assets, ${p.unsupportedAssets.length} unsupported; supported $${p.supportedAssetValueUsd} / unsupported $${p.unsupportedAssetValueUsd}; no auto-quotes: ${!autoQuoted}; address in metrics: ${leaks}; ${portfolioMs} ms${problems.length ? `; ${problems.slice(0, 3).join("; ")}` : ""}`);
    const nv = p.assets.find((a) => a.asset?.key === K(NVDA));
    if (nv?.balance?.stock) report.add(nv.balance.stock.uiMultiplier ? "PASS" : "FAIL", "Stock Token balance semantics", `token balance + share-equivalent (uiMultiplier ${nv.balance.stock.uiMultiplier}); Pendle units do not alter it`);
  }

  // ---- controlled adapter outages at the service level ----
  const reg = rt.getRegistry;
  for (const down of ["morpho", "pendle", "uniswap"]) {
    const adapters: OpportunityAdapter[] = [new MorphoAdapter(rt.http), new PendleAdapter(rt.http), new UniswapAdapter({ store: new FilePoolListStore(UNISWAP_POOL_CACHE_PATH) })].map((a) =>
      a.protocol.id === down ? Object.assign(Object.create(a) as OpportunityAdapter, { getOpportunities: async () => { throw new Error(`${down} forced outage (validation)`); } }) : a,
    );
    const s = new AssetIntelligenceService({ engine: new OpportunityEngine(adapters, { reader: rt.reader, getRegistry: reg, prices: rt.prices }), getPortfolio: () => Promise.reject(new Error("unused")) });
    const v = await s.getAssetIntelligence(NVDA);
    const named = v.dataQuality.reasons.some((r) => r.code === `${down.toUpperCase()}_UNAVAILABLE`);
    const gone = !cardsOf(v).some((c) => c.protocol.id === down);
    const others = cardsOf(v).length > 0;
    report.add(named && gone && others && v.dataQuality.status !== "COMPLETE" ? "PASS" : "FAIL", `outage: ${down}`, `quality ${v.dataQuality.status} (${v.dataQuality.reasons.map((r) => r.code).join(",")}); ${cardsOf(v).length} cards from the other protocols; capabilities ${json(v.summary.capabilities.detail)}`);
  }

  // ---- performance ----
  const m = svc.metrics.snapshot();
  report.info("performance", `NVDA cold ${nvdaCold} ms (incl. engine snapshot), warm ${nvdaWarm} ms, quoted ${quotedMs} ms, USDG ${usdgMs} ms, coverage ${coverageMs} ms; projection p50 ${m.timings["projection_latency_ms"]?.p50} ms p95 ${m.timings["projection_latency_ms"]?.p95} ms; quote p50 ${m.timings["quote_latency_ms{kind=DIRECT}"]?.p50 ?? "-"}/${m.timings["quote_latency_ms{kind=ONE_HOP}"]?.p50 ?? "-"} ms (direct/one-hop)`);
  report.info("rpc health", JSON.stringify(rt.reader.health()));
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  process.exitCode = (await validateIntelligence()).finish();
}

