/**
 * Phase 5 product read API (AssetIntelligenceService) — offline and deterministic, over the
 * three-protocol fixture world (Morpho + Pendle + Uniswap v3).
 */
import { describe, expect, it } from "vitest";
import { PRODUCT_MAX_ROUTES_PER_TARGET } from "@skein/robinhood/config/trade";
import { Metrics } from "@skein/product/metrics";
import { IncompatibleRankingError, rankCards } from "@skein/product/ranking";
import type { AssetIntelligence, ProductCard } from "@skein/product/types";
import { intelligenceStack } from "@skein/testkit/intelligence";
import { FAKE_NVDA } from "@skein/testkit/morpho";
import { AAPL, NOW, NVDA, ONE, USDG, WALLET, WETH } from "@skein/testkit/world";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const K = (a: string) => `4663:${a.toLowerCase()}`;
const j = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
const cardsOf = (v: AssetIntelligence) => v.categories.flatMap((c) => c.subcategories.flatMap((s) => s.cards));
const sub = (v: AssetIntelligence, s: string) => v.categories.flatMap((c) => c.subcategories).find((x) => x.subcategory === s);

describe("projection: raw opportunities → AssetIntelligence", () => {
  it("NVDA: every intent present, top-level categories in fixed order, never ranked across categories", async () => {
    const { service } = await intelligenceStack();
    const v = await service.getAssetIntelligence(NVDA);
    expect(v.asset?.symbol).toBe("NVDA");
    expect(v.categories.map((c) => c.category)).toEqual(["TRADE", "EARN", "BORROW", "LIQUIDITY"]);
    expect(v.summary.capabilities).toMatchObject({ canTrade: true, canEarn: true, canBorrowAgainst: true, canProvideLiquidity: true });
    for (const c of v.categories) for (const s of c.subcategories) {
      expect(s.cards.every((x) => x.subcategory === s.subcategory && x.category === c.category)).toBe(true);
      // positions restart per subcategory (and, for TRADE, per target)
      const groups = new Map<string, number[]>();
      for (const x of s.cards) {
        const g = x.ranking!.context?.target ?? "-";
        groups.set(g, [...(groups.get(g) ?? []), x.ranking!.position]);
      }
      for (const ps of groups.values()) expect(ps).toEqual(ps.map((_, i) => i + 1));
    }
  });

  it("counts: discovered / verified / actionable / limited / hidden are kept separate and add up", async () => {
    const { service } = await intelligenceStack();
    for (const a of [NVDA, USDG, AAPL]) {
      const c = (await service.getAssetIntelligence(a)).summary.counts;
      expect(c.actionable + c.limited + c.informational + c.hidden + c.unavailable).toBe(c.discovered);
      expect(c.verified).toBeLessThanOrEqual(c.discovered);
    }
  });

  it("RAW mode is the engine's untouched output", async () => {
    const { service, engine } = await intelligenceStack();
    const raw = await service.getRawOpportunities({ eligibility: "ALL" });
    const direct = await engine.getOpportunities({ eligibility: "ALL" });
    expect(raw.data.map((o) => o.id).sort()).toEqual(direct.data.map((o) => o.id).sort());
  });

  it("getCategory returns one intent of the same view", async () => {
    const { service } = await intelligenceStack();
    const earn = await service.getCategory(USDG, "EARN");
    expect(earn?.category).toBe("EARN");
    expect(earn?.subcategories.map((s) => s.subcategory)).toEqual(["LEND", "FIXED_YIELD", "YIELD"]);
    expect(await service.getCategory(USDG, "BORROW")).toBeNull();
  });
});

describe("default product filter and usability", () => {
  it("excludes conflicted, non-canonical, expired, deposit-disabled, dust and unverified items; DEBUG explains each", async () => {
    const { service } = await intelligenceStack();
    const prod = await service.getAssetIntelligence(USDG);
    expect(prod.excluded).toBeUndefined();
    for (const c of cardsOf(prod)) expect(["ACTIONABLE", "LIMITED", "INFORMATIONAL"]).toContain(c.usability.status);
    const dbg = await service.getAssetIntelligence(USDG, { mode: "DEBUG" });
    const reasons = new Set(dbg.excluded!.flatMap((c) => c.usability.reasons));
    for (const r of ["DATA_CONFLICT", "NON_CANONICAL_ASSET", "EXPIRED", "DEPOSIT_DISABLED", "DUST_LIQUIDITY", "INSUFFICIENT_VERIFICATION"]) expect(reasons.has(r as never)).toBe(true);
    for (const c of dbg.excluded!) {
      expect(["HIDDEN_BY_DEFAULT", "UNAVAILABLE"]).toContain(c.usability.status);
      expect(c.usability.reasons.length).toBeGreaterThan(0);
    }
    const expired = dbg.excluded!.filter((c) => c.usability.reasons.includes("EXPIRED"));
    expect(expired.every((c) => c.usability.status === "UNAVAILABLE")).toBe(true);
  });

  it("Stock Token YT with unresolved yield semantics is hidden by default (P3-1)", async () => {
    const { service } = await intelligenceStack();
    const dbg = await service.getAssetIntelligence(NVDA, { mode: "DEBUG" });
    expect(sub(dbg, "YIELD")).toBeUndefined();
    expect(dbg.excluded!.find((c) => c.subcategory === "YIELD")?.usability.reasons).toContain("UNRESOLVED_YIELD_SEMANTICS");
  });

  it("fail-closed: an unreadable uiMultiplier keeps Stock Token YT semantics UNRESOLVED (never actionable)", async () => {
    const { service } = await intelligenceStack({ mutateWorld: (w) => w.multipliers.set(NVDA.toLowerCase(), "revert") });
    const dbg = await service.getAssetIntelligence(NVDA, { mode: "DEBUG" });
    expect(cardsOf(dbg).some((c) => c.subcategory === "YIELD")).toBe(false);
    expect(dbg.excluded!.find((c) => c.subcategory === "YIELD")?.usability.reasons).toContain("UNRESOLVED_YIELD_SEMANTICS");
  });

  it("collateral market with nothing to borrow is INFORMATIONAL, and is not a borrow capability", async () => {
    const { service } = await intelligenceStack();
    const v = await service.getAssetIntelligence(AAPL);
    const col = sub(v, "COLLATERAL")!.cards;
    expect(col).toHaveLength(1);
    expect(col[0]!.usability).toMatchObject({ status: "INFORMATIONAL", reasons: ["ZERO_BORROWABLE_LIQUIDITY"] });
    expect(v.summary.capabilities.canBorrowAgainst).toBe(false);
    expect(v.summary.capabilities.detail.BORROW).toBe("INFORMATIONAL_ONLY");
  });

  it("dust TRADE pool (< $50) never becomes a product route; the global dust threshold is unchanged", async () => {
    const { service } = await intelligenceStack();
    const v = await service.getAssetIntelligence(AAPL, { mode: "DEBUG" });
    expect(sub(v, "TRADE")).toBeUndefined();
    expect(v.summary.capabilities.canTrade).toBe(false);
  });

  it("neutral labels only: no BEST / SAFEST / GUARANTEED / RISK FREE / RECOMMENDED anywhere in the output", async () => {
    const { service } = await intelligenceStack();
    for (const a of [NVDA, USDG, AAPL, WETH]) {
      const text = j(await service.getAssetIntelligence(a, { mode: "DEBUG" }));
      // Only negations may mention a guarantee ("Not guaranteed", IMPLIED_RATE_NOT_GUARANTEED).
      expect(text).not.toMatch(/\bbest\b|safest|\bsafe\b|(?<!not[ _]|not a )guaranteed|risk[ -]?free|(?<!not |not a )recommended(?!Borrow)/i);
    }
    const labels = cardsOf(await service.getAssetIntelligence(USDG)).map((c) => c.actionLabel);
    expect(labels).toEqual(expect.arrayContaining(["Supply USDG", "Trade USDG → WETH", "Provide USDG liquidity"]));
  });
});

describe("ranking", () => {
  it("is deterministic (same input → same order) and exposes its factors", async () => {
    const a = await (await intelligenceStack()).service.getAssetIntelligence(USDG);
    const b = await (await intelligenceStack()).service.getAssetIntelligence(USDG);
    expect(cardsOf(a).map((c) => c.cardId)).toEqual(cardsOf(b).map((c) => c.cardId));
    for (const c of cardsOf(a)) expect(c.ranking).toMatchObject({ comparator: expect.stringMatching(/_V1$/), primary: "USABILITY", secondary: expect.any(Array) });
    expect(sub(a, "LEND")!.comparator).toBe("LEND_V1");
    expect(sub(a, "FIXED_YIELD")!.comparator).toBe("FIXED_YIELD_V1");
  });

  it("refuses to rank across subcategories", async () => {
    const v = await (await intelligenceStack()).service.getAssetIntelligence(USDG);
    const mixed = [...sub(v, "LEND")!.cards, ...sub(v, "FIXED_YIELD")!.cards];
    expect(() => rankCards(mixed, "LEND")).toThrow(IncompatibleRankingError);
  });

  it("unknown values sort last, never as zero; usability outranks any metric", () => {
    const base = (id: string, apy: bigint | null, status: ProductCard["usability"]["status"] = "ACTIONABLE"): ProductCard =>
      ({ cardId: id, subcategory: "LEND", usability: { status, reasons: [], notes: [], policies: [] }, headline: apy === null ? null : { type: "SUPPLY_APY", side: "EARN", value: apy, unit: "u" }, metrics: [], liquidity: null, tvlUsd: null, maturity: null }) as unknown as ProductCard;
    const r = rankCards([base("a", null), base("b", 0n), base("c", 5n * 10n ** 16n), base("d", 9n * 10n ** 17n, "LIMITED")], "LEND");
    expect(r.map((c) => c.cardId)).toEqual(["c", "b", "a", "d"]);
  });

  it("rates in different units are not compared (implied APY across accounting units)", () => {
    const pt = (id: string, apy: bigint, unit: string): ProductCard =>
      ({ cardId: id, subcategory: "FIXED_YIELD", usability: { status: "ACTIONABLE", reasons: [], notes: [], policies: [] }, headline: { type: "IMPLIED_APY", side: "EARN", value: apy, unit }, metrics: [], liquidity: null, maturity: "2027-01-01T00:00:00.000Z" }) as unknown as ProductCard;
    // different units ⇒ the rate step is skipped; falls through to cardId
    expect(rankCards([pt("b", 9n, "accounting:x"), pt("a", 1n, "y")], "FIXED_YIELD").map((c) => c.cardId)).toEqual(["a", "b"]);
    expect(rankCards([pt("b", 9n, "y"), pt("a", 1n, "y")], "FIXED_YIELD").map((c) => c.cardId)).toEqual(["b", "a"]);
  });
});

describe("trade display", () => {
  it("without an amount: route information only (no quotes), grouped by the default targets USDG and WETH", async () => {
    const { service } = await intelligenceStack();
    const t = sub(await service.getAssetIntelligence(NVDA), "TRADE")!;
    expect(t.comparator).toBe("TRADE_ROUTE_V1");
    expect(t.cards.every((c) => c.trade && c.trade.quote === null && c.trade.route.volume24h === "UNKNOWN")).toBe(true);
    expect(new Set(t.cards.map((c) => c.ranking!.context!.target))).toEqual(new Set([K(USDG), K(WETH)]));
    expect(t.cards.every((c) => c.usability.notes.includes("VOLUME_UNKNOWN"))).toBe(true);
  });

  it("with an explicit amount and target: indicative quotes, ranked by expected output, never a guarantee", async () => {
    const { service } = await intelligenceStack();
    const t = sub(await service.getAssetIntelligence(NVDA, { tradeTarget: USDG, tradeAmount: "1" }), "TRADE")!;
    expect(t.comparator).toBe("TRADE_QUOTE_V1");
    const qs = t.cards.map((c) => c.trade!.quote!);
    expect(qs.every((q) => q.kind === "INDICATIVE_QUOTE" && q.guarantee === "NONE" && q.input.raw === ONE)).toBe(true);
    for (let i = 1; i < qs.length; i++) expect(qs[i - 1]!.expectedOutput.raw >= qs[i]!.expectedOutput.raw).toBe(true);
    expect(qs[0]!.priceImpactClass).toBe("LOW");
    expect(j(t)).not.toMatch(/minimumAmountOut|minAmountOut|calldata/i);
  });

  it("an amount without an explicit target is rejected (amounts are never spread over defaults or inferred)", async () => {
    const { service } = await intelligenceStack();
    await expect(service.getAssetIntelligence(NVDA, { tradeAmount: "1" })).rejects.toThrow(/requires tradeTarget/);
    await expect(service.getAssetIntelligence(NVDA, { tradeTarget: USDG, tradeAmount: "-1" })).rejects.toThrow();
  });

  it("price impact classes drive usability: ELEVATED/HIGH are LIMITED, EXTREME is hidden by default", async () => {
    const { service } = await intelligenceStack();
    const seen = new Map<string, string>();
    for (const amount of ["1", "300", "2000", "15000"]) {
      const v = await service.getAssetIntelligence(NVDA, { mode: "DEBUG", tradeTarget: USDG, tradeAmount: amount });
      for (const c of [...cardsOf(v), ...(v.excluded ?? [])].filter((x) => x.trade?.quote)) seen.set(c.trade!.quote!.priceImpactClass, c.usability.status);
    }
    expect(seen.get("LOW")).toBe("ACTIONABLE");
    expect(seen.get("ELEVATED")).toBe("LIMITED");
    expect(seen.get("HIGH")).toBe("LIMITED");
    expect(seen.get("EXTREME")).toBe("HIDDEN_BY_DEFAULT");
  });

  it("route cards are capped per target in PRODUCT mode (moreRoutes), complete in DEBUG; fee tiers are never merged", async () => {
    const { service } = await intelligenceStack({
      mutatePools: (p) => {
        for (const [i, fee, ts] of [[0xc101, 100, 1], [0xc102, 3000, 60], [0xc103, 10000, 200]] as const) p[`nvdaUsdg${fee}`] = { ...p.nvdaUsdg!, pool: addr(i), fee, tickSpacing: ts, createdAt: 60_000_100n + BigInt(i) };
        p.wethUsdg500 = { ...p.wethUsdg!, pool: addr(0xc104), fee: 500, tickSpacing: 10, createdAt: 60_000_200n };
      },
    });
    const prod = sub(await service.getAssetIntelligence(NVDA), "TRADE")!;
    const usdg = prod.cards.filter((c) => c.ranking!.context!.target === K(USDG));
    expect(usdg).toHaveLength(PRODUCT_MAX_ROUTES_PER_TARGET);
    expect(prod.moreRoutes).toContainEqual({ target: K(USDG), shown: PRODUCT_MAX_ROUTES_PER_TARGET, total: 6 });
    const dbg = sub(await service.getAssetIntelligence(NVDA, { mode: "DEBUG" }), "TRADE")!;
    const all = dbg.cards.filter((c) => c.ranking!.context!.target === K(USDG));
    expect(all).toHaveLength(6);
    expect(new Set(all.map((c) => c.cardId)).size).toBe(6);
    expect(new Set(all.filter((c) => c.trade!.route.kind === "DIRECT").map((c) => c.trade!.route.combinedFeePpm))).toEqual(new Set([100, 500, 3000, 10000]));
  });
});

describe("card identity", () => {
  it("cardIds are deterministic and unique within a view; each card lists its raw opportunities", async () => {
    const { service } = await intelligenceStack();
    for (const a of [NVDA, USDG]) {
      const v = await service.getAssetIntelligence(a, { mode: "DEBUG" });
      const ids = [...cardsOf(v), ...v.excluded!].map((c) => c.cardId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const c of cardsOf(v)) if (c.rawCategory !== "TRADE_ROUTE") expect(c.sourceOpportunityIds.length).toBeGreaterThan(0);
    }
  });
});

describe("Pendle PT and borrow capacity views", () => {
  it("PT: implied APY, maturity, accounting unit and explicit conditions (not guaranteed)", async () => {
    const { service } = await intelligenceStack();
    const pt = sub(await service.getAssetIntelligence(NVDA), "FIXED_YIELD")!.cards[0]!;
    expect(pt.actionLabel).toMatch(/^Buy PT-NVDA/);
    expect(pt.fixedYield!.impliedApy!.type).toBe("IMPLIED_APY");
    expect(pt.fixedYield!.maturity).toBe(pt.maturity);
    expect(pt.fixedYield!.secondsToMaturity).toBeGreaterThan(0);
    expect(pt.fixedYield!.accountingUnit.assetType).toBe("LIQUIDITY");
    expect(pt.fixedYield!.impliedApy!.unit).toMatch(/^accounting:/);
    expect(pt.fixedYield!.conditions.join(" ")).toMatch(/not guaranteed/i);
    expect(pt.usability.notes).toEqual(expect.arrayContaining(["ACCOUNTING_UNIT_NOT_TOKEN", "IMPLIED_RATE_NOT_GUARANTEED"]));
  });

  it("borrow capacity with a holding: THEORETICAL_LIMIT only, no recommendation, exact integer math", async () => {
    const { service } = await intelligenceStack();
    const p = await service.getPortfolioIntelligence(WALLET);
    const nvda = p.assets.find((a) => a.asset?.symbol === "NVDA")!;
    const bc = sub(nvda, "COLLATERAL")!.cards[0]!.borrowCapacity!;
    expect(bc.kind).toBe("THEORETICAL_LIMIT");
    expect(bc.recommendedBorrow).toBeNull();
    expect(typeof bc.maxBorrow!.amount.raw).toBe("bigint");
    expect(bc.collateral.amount.raw).toBe(nvda.balance!.rawBalance);
    expect(bc.caveat).toMatch(/liquidat/i);
    // without a holding there is no capacity at all
    expect(sub(await service.getAssetIntelligence(NVDA), "COLLATERAL")!.cards[0]!.borrowCapacity).toBeUndefined();
  });
});

describe("portfolio intelligence", () => {
  it("supported vs unsupported value, Phase 1 Stock Token balance semantics, no auto-quote of balances", async () => {
    const st = await intelligenceStack();
    let quotes = 0;
    const orig = st.engine.getTradeQuote.bind(st.engine);
    st.engine.getTradeQuote = ((...a: Parameters<typeof orig>) => {
      quotes++;
      return orig(...a);
    }) as typeof orig;
    const p = await st.service.getPortfolioIntelligence(WALLET);
    expect(quotes).toBe(0);
    expect(p.supportedAssetValueUsd).not.toBeNull();
    expect(p.unsupportedAssetValueUsd).not.toBeNull();
    const nvda = p.assets.find((a) => a.asset?.symbol === "NVDA")!;
    expect(nvda.balance!.stock!.uiMultiplier).toBe("1.000775159164630595");
    // token balance is the raw ERC-20 balance; share-equivalent is display only
    expect(nvda.balance!.displayBalance).not.toBe(nvda.balance!.stock!.displayShareBalance);
    expect(p.assets.every((a) => a.categories.every((c) => c.subcategories.every((s) => s.cards.every((x) => !x.trade?.quote))))).toBe(true);
    const counts = p.opportunityCounts;
    expect(counts.discovered).toBe(p.assets.reduce((s, a) => s + a.summary.counts.discovered, 0));
  });

  it("the wallet reaches only the balance reader; metrics carry no addresses or balances", async () => {
    const st = await intelligenceStack();
    await st.service.getPortfolioIntelligence(WALLET);
    expect(st.portfolioCalls()).toBe(1);
    const m = j(st.service.metrics.snapshot());
    expect(m).not.toMatch(/0x[0-9a-f]{6,}/i);
    expect(m).not.toContain(WALLET.slice(2, 12));
  });
});

describe("empty states", () => {
  it("unknown asset, non-canonical asset, no balance, no usable opportunities", async () => {
    const { service } = await intelligenceStack();
    expect((await service.getAssetIntelligence(addr(0xdead))).emptyStates).toContain("UNKNOWN_ASSET");
    expect((await service.getAssetIntelligence("not-an-address")).emptyStates).toContain("UNKNOWN_ASSET");
    expect((await service.getAssetIntelligence(NVDA)).emptyStates).toContain("NO_BALANCE");
    const aapl = await service.getAssetIntelligence(AAPL);
    expect(aapl.summary.capabilities.canTrade || aapl.summary.capabilities.canEarn).toBe(false);
    const fake = await service.getAssetIntelligence(FAKE_NVDA);
    expect(fake.emptyStates.some((e) => e === "UNKNOWN_ASSET" || e === "NON_CANONICAL_ASSET")).toBe(true);
    expect(cardsOf(fake)).toHaveLength(0);
  });
});

describe("adapter failures and data quality", () => {
  it("one protocol down: its intents disappear, the rest stays, dataQuality names the protocol", async () => {
    const { service } = await intelligenceStack({ failing: ["morpho"] });
    const v = await service.getAssetIntelligence(NVDA);
    expect(v.summary.capabilities.detail.BORROW).toBe("NONE");
    expect(v.summary.capabilities.canTrade).toBe(true);
    expect(v.dataQuality.status).not.toBe("COMPLETE");
    expect(v.dataQuality.reasons.map((r) => r.code)).toContain("MORPHO_UNAVAILABLE");
  });

  it("every protocol down: explicit ADAPTERS_UNAVAILABLE, no cards", async () => {
    const { service } = await intelligenceStack({ failing: ["morpho", "pendle", "uniswap"] });
    const v = await service.getAssetIntelligence(NVDA);
    expect(v.emptyStates).toContain("ADAPTERS_UNAVAILABLE");
    expect(cardsOf(v)).toHaveLength(0);
    expect(v.dataQuality.status).not.toBe("COMPLETE");
  });

  it("all healthy: COMPLETE with a freshness summary evaluated at response time", async () => {
    const { service } = await intelligenceStack();
    const v = await service.getAssetIntelligence(NVDA);
    expect(v.dataQuality.status).toBe("COMPLETE");
    expect(v.freshness.evaluatedAt).toBe(NOW.toISOString());
    expect(v.freshness.oldestCriticalDataAt! <= v.freshness.newestDataAt!).toBe(true);
    expect(v.price).toMatchObject({ kind: "PORTFOLIO_PRICE", usd: expect.any(String) });
  });
});

describe("caching and metrics", () => {
  it("views are cached per (asset, mode, target, amount) within the snapshot TTL; freshness is re-evaluated", async () => {
    const clock = { t: NOW.getTime() };
    const { service } = await intelligenceStack({ clock });
    await service.getAssetIntelligence(NVDA);
    clock.t += 5_000;
    const hit = await service.getAssetIntelligence(NVDA);
    expect(hit.freshness.evaluatedAt).toBe(new Date(clock.t).toISOString());
    const q = await service.getAssetIntelligence(NVDA, { tradeTarget: USDG, tradeAmount: "2" });
    expect(sub(q, "TRADE")!.cards[0]!.trade!.quote!.input.raw).toBe(2n * ONE);
    clock.t += 20_000; // past PRODUCT_SNAPSHOT
    await service.getAssetIntelligence(NVDA);
    const c = service.metrics.snapshot().counters;
    expect(c["cache_hit{cache=asset_view}"]).toBe(1);
    expect(c["cache_miss{cache=snapshot}"]).toBe(2);
  });

  it("metric labels reject addresses and free text", () => {
    const m = new Metrics();
    expect(() => m.inc("cache_hit", 1, { wallet: "0x1111111111111111111111111111111111111111" })).toThrow();
    expect(() => m.inc("cache_hit", 1, { note: "has spaces" })).toThrow();
    m.inc("cache_hit", 1, { cache: "asset_view" });
    expect(m.snapshot().counters["cache_hit{cache=asset_view}"]).toBe(1);
  });
});

describe("coverage matrix", () => {
  it("one row per canonical asset with separate counts and derived capabilities", async () => {
    const { service, s } = await intelligenceStack();
    const rows = await service.getCoverage();
    expect(rows.map((r) => r.asset.key).sort()).toEqual(s.registry.canonical().filter((a) => a.address).map((a) => a.key).sort());
    const usdg = rows.find((r) => r.asset.symbol === "USDG")!;
    expect(usdg.capabilities.canEarn).toBe(true);
    expect(usdg.byRawCategory.LEND).toBeGreaterThan(0);
    const aapl = rows.find((r) => r.asset.symbol === "AAPL")!;
    expect(aapl.capabilities.detail.BORROW).toBe("INFORMATIONAL_ONLY");
    expect(j(rows)).not.toMatch(/\bbest\b|safest|(?<!not[ _]|not a )guaranteed/i);
  });
});

describe("server mode: stale-while-revalidate snapshot", () => {
  it("serves the expired snapshot within the window and refreshes in the background; freshness is still evaluated now", async () => {
    const clock = { t: NOW.getTime() };
    const { service } = await intelligenceStack({ clock, maxStaleMs: 60_000 });
    const a = await service.getAssetIntelligence(USDG);
    clock.t += 30_000; // past the 15 s TTL, inside the stale window
    const b = await service.getAssetIntelligence(USDG, { mode: "DEBUG" });
    expect(b.blockNumber).toBe(a.blockNumber);
    expect(b.freshness.evaluatedAt).toBe(new Date(clock.t).toISOString());
    const c = service.metrics.snapshot().counters;
    expect(c["cache_hit{cache=snapshot_stale}"]).toBe(1);
    clock.t += 120_000; // beyond the window: a blocking reload
    await service.getAssetIntelligence(USDG);
    expect(service.metrics.snapshot().counters["cache_miss{cache=snapshot}"]).toBeGreaterThanOrEqual(2);
  });
});

describe("improvements: trade targets and borrowable now", () => {
  it("tradeTargets lists exactly the graph destinations (direct + one hop); none for an asset without routes", async () => {
    const { service } = await intelligenceStack();
    const v = await service.getAssetIntelligence(NVDA);
    const syms = v.tradeTargets.map((x) => `${x.symbol}:${x.kind}`).sort();
    expect(syms).toEqual(expect.arrayContaining(["USDG:DIRECT", "WETH:DIRECT"]));
    expect(v.tradeTargets.every((x) => x.key !== v.asset!.key)).toBe(true);
    const aapl = await service.getAssetIntelligence(AAPL); // only a dust pool: no route
    expect(aapl.tradeTargets).toEqual([]);
  });

  it("borrowableNow = min(protocol limit, market liquidity), exact integers", async () => {
    const { service } = await intelligenceStack();
    const p = await service.getPortfolioIntelligence(WALLET);
    const card = sub(p.assets.find((a) => a.asset?.symbol === "NVDA")!, "COLLATERAL")!.cards[0]!;
    const bc = card.borrowCapacity!;
    const liq = card.liquidity!;
    expect(bc.borrowableNow).not.toBeNull();
    const now = bc.borrowableNow!;
    expect(now.amount.raw <= bc.maxBorrow!.amount.raw).toBe(true);
    expect(now.cappedBy).toBe(now.amount.raw === bc.maxBorrow!.amount.raw ? "PROTOCOL_LIMIT" : "MARKET_LIQUIDITY");
    expect(liq).toBeTruthy();
  });
});

describe("portfolio: open positions", () => {
  it("lists Morpho lending and Pendle PT positions with health factor and LLTV; the wallet reaches no protocol API", async () => {
    const { marketIdOf } = await import("@skein/protocols/morpho/onchain");
    const { fixtureMarkets } = await import("@skein/testkit/morpho");
    const id = marketIdOf(fixtureMarkets().nvdaOk.params).toLowerCase();
    const st = await intelligenceStack({
      pendleBalances: { nvda: { pt: 5n * ONE } },
      mutateWorld: (w) => w.morpho!.positions.set(`${id}:${WALLET.toLowerCase()}`, { supplyShares: 0n, borrowShares: 100_000_000_000_000n, collateral: 2n * ONE }),
    });
    const p = await st.service.getPortfolioIntelligence(WALLET);
    const lend = p.positions.find((x) => x.kind === "LENDING_MARKET")!;
    expect(lend.protocol.name).toBe("Morpho");
    expect(lend.borrowed?.asset.symbol).toBe("USDG");
    expect(lend.collateral?.amount?.raw).toBe(2n * ONE);
    expect(typeof lend.healthFactor).toBe("bigint");
    expect(lend.liquidationLtv).toBe(625n * 10n ** 15n);
    expect(lend.liquidatable).toBe(false);
    expect(p.positions[0]!.kind).toBe("LENDING_MARKET"); // debt first
    const pt = p.positions.find((x) => x.kind === "PRINCIPAL_TOKEN")!;
    expect(pt.protocol.name).toBe("Pendle");
    expect(pt.maturity?.expired).toBe(false);
    expect(j(st.service.metrics.snapshot())).not.toContain(WALLET.slice(2, 12));
  });
});

describe("third-party volume on routes", () => {
  it("adds GeckoTerminal volume to shown route markets and drops VOLUME_UNKNOWN when every hop has one; ranking unchanged", async () => {
    const plain = sub(await (await intelligenceStack()).service.getAssetIntelligence(NVDA), "TRADE")!;
    const volumes = { get: async (pools: readonly string[]) => new Map(pools.map((p) => [p, { usd24h: 1234, txs24h: 9, observedAt: NOW.toISOString(), source: "GeckoTerminal" as const, url: `https://www.geckoterminal.com/robinhood/pools/${p}` }])) };
    const t = sub(await (await intelligenceStack({ volumes })).service.getAssetIntelligence(NVDA), "TRADE")!;
    expect(t.cards.map((c) => c.cardId)).toEqual(plain.cards.map((c) => c.cardId));
    for (const c of t.cards) {
      expect(c.trade!.route.markets.every((m) => m.volume24h?.usd === 1234)).toBe(true);
      expect(c.usability.notes).not.toContain("VOLUME_UNKNOWN");
    }
  });
});
