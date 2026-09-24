/**
 * Uniswap v3 TRADE adapter, generic trade graph/routing/quotes, and three-protocol aggregation —
 * offline and deterministic.
 */
import { describe, expect, it } from "vitest";
import type { Opportunity } from "../../src/model/opportunity.js";
import type { TradeQuote } from "../../src/model/trade.js";
import { OpportunityEngine } from "../../src/opportunities/engine.js";
import type { OpportunityAdapter } from "../../src/opportunities/adapter.js";
import { getPortfolio } from "../../src/portfolio/engine.js";
import { MorphoAdapter } from "../../src/protocols/morpho/adapter.js";
import { PendleAdapter } from "../../src/protocols/pendle/adapter.js";
import { UniswapAdapter } from "../../src/protocols/uniswap/adapter.js";
import { price0In1, price1In0, priceImpact, hopSpotRational, Q192 } from "../../src/protocols/uniswap/math.js";
import { MemoryPoolListStore } from "../../src/protocols/uniswap/poolStore.js";
import { buildTradeGraph, destinations, findRoutes } from "../../src/trade/graph.js";
import { orderQuotesByOutput, quotesComparable } from "../../src/trade/compare.js";
import { FakeMorphoApi, fixtureMarkets, installMorpho } from "../fixtures/morpho.js";
import { FakePendleApi, fixturePendleMarkets, installPendle } from "../fixtures/pendle.js";
import { FAKE_NVDA, fixtureUniswapPools, installUniswap, type FixturePool, type UniswapWorldOptions } from "../fixtures/uniswap.js";
import { AAPL, BLOCK, defaultWorld, NOW, NVDA, ONE, testStack, UNKNOWN_FAKE_USDG, USDG, WALLET, WETH } from "../fixtures/world.js";

const K = (a: string) => `4663:${a.toLowerCase()}`;
const ALL = { eligibility: "ALL" as const };

async function setup(
  opts: {
    pools?: Record<string, FixturePool>;
    world?: UniswapWorldOptions;
    protocols?: ("morpho" | "pendle" | "uniswap")[];
    clock?: { t: number };
    store?: MemoryPoolListStore;
    mutateWorld?: (w: ReturnType<typeof defaultWorld>) => void;
    quoteTimeoutMs?: number;
  } = {},
) {
  const pools = opts.pools ?? fixtureUniswapPools();
  const world = defaultWorld();
  const control = installUniswap(world, pools, opts.world);
  const protocols = opts.protocols ?? ["uniswap"];
  const mm = fixtureMarkets();
  const pm = fixturePendleMarkets();
  if (protocols.includes("morpho")) installMorpho(world, mm);
  if (protocols.includes("pendle")) installPendle(world, pm);
  opts.mutateWorld?.(world);
  const s = await testStack({ world });
  const clock = opts.clock ?? { t: NOW.getTime() };
  const store = opts.store ?? new MemoryPoolListStore();
  const uni = new UniswapAdapter({ store, now: () => clock.t });
  const adapters: OpportunityAdapter[] = [];
  if (protocols.includes("morpho")) adapters.push(new MorphoAdapter(s.http, { api: new FakeMorphoApi(Object.values(mm).map((m) => m.apiRaw)), now: () => clock.t }));
  if (protocols.includes("pendle")) adapters.push(new PendleAdapter(s.http, { api: new FakePendleApi(pm), now: () => clock.t }));
  if (protocols.includes("uniswap")) adapters.push(uni);
  const engine = new OpportunityEngine(adapters, { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now, ...(opts.quoteTimeoutMs ? { quoteTimeoutMs: opts.quoteTimeoutMs } : {}) });
  return { s, engine, uni, pools, world, control, store, clock };
}

const tradeFor = (list: Opportunity[], pool: FixturePool, input: string) => list.find((o) => o.category === "TRADE" && o.venue.id === pool.pool.toLowerCase() && o.primaryAsset.address.toLowerCase() === input.toLowerCase());

describe("pool discovery and verification", () => {
  it("discovers pools from factory PoolCreated logs (none hardcoded), indexes canonical-side pools only", async () => {
    const { engine, pools, uni } = await setup();
    const r = await engine.getTradeMarkets();
    const ids = new Set(r.data.map((m) => m.marketId));
    for (const k of ["nvdaUsdg", "nvdaWeth", "wethUsdg", "aaplDust", "fakeNvdaAapl", "fakeUsdgNvda", "broken", "zeroLiquidity", "unpriced"]) expect(ids.has(pools[k]!.pool.toLowerCase())).toBe(true);
    // hub (USDG) vs non-canonical token is outside the indexed scope
    expect(ids.has(pools.fakeNvda!.pool.toLowerCase())).toBe(false);
    expect(uni.stats.fullScans).toBe(1);
    expect(r.status).toBe("COMPLETE");
  });

  it("a duplicate PoolCreated log yields one market and two direction opportunities", async () => {
    const { engine, pools } = await setup({ world: { duplicateLogFor: "nvdaUsdg" } });
    const all = (await engine.getOpportunities(ALL)).data.filter((o) => o.venue.id === pools.nvdaUsdg!.pool.toLowerCase());
    expect(all).toHaveLength(2);
    expect(new Set(all.map((o) => o.primaryAsset.symbol))).toEqual(new Set(["NVDA", "USDG"]));
  });

  it("factory origin: pool.factory() mismatch ⇒ not verified, excluded by default, not a routing edge", async () => {
    const { engine, pools } = await setup();
    const o = tradeFor((await engine.getOpportunities(ALL)).data, pools.broken!, NVDA)!;
    expect(o.verificationStatus).toBe("UNVERIFIED");
    expect(o.trade!.market.originVerified).toBe(false);
    expect(o.warnings.map((w) => w.code)).toContain("POOL_UNVERIFIED");
    expect(o.eligibility!.excludedBy).toContain("INSUFFICIENT_VERIFICATION");
    const routes = await engine.getTradeRoutes(K(NVDA), K(USDG));
    expect(routes.data.direct.every((r) => r.hops[0]!.marketId !== o.trade!.market.id)).toBe(true);
  });

  it("token ordering and fee are checked against the factory event and the pool", async () => {
    const { engine, pools } = await setup();
    const o = tradeFor((await engine.getOpportunities()).data, pools.nvdaUsdg!, NVDA)!;
    if (o.details.kind !== "UNISWAP_V3_POOL") throw new Error();
    expect(o.details.identityChecks.every((c) => c.ok === true)).toBe(true);
    expect(o.details.identityChecks.map((c) => c.check)).toEqual(expect.arrayContaining(["pool.factory() == v3 factory", "factory.getPool(token0, token1, fee) == pool", "token0 < token1 (Uniswap ordering)", "tickSpacing matches the fee tier"]));
    expect(o.trade!.market.fee?.value).toEqual({ ppm: 500, kind: "STATIC" });
    expect(o.trade!.market.assets.map((a) => a.address)).toEqual([pools.nvdaUsdg!.token0, pools.nvdaUsdg!.token1]);
  });

  it("identity is read once per pool (cache), state every block; incremental rescans after the list TTL", async () => {
    const clock = { t: NOW.getTime() };
    const { engine, uni, world, s } = await setup({ clock });
    await engine.getOpportunities();
    const reads = world.callCounts!.get("tickSpacing")!;
    const slot0 = world.callCounts!.get("slot0")!;
    clock.t += 20_000; // beyond the per-block snapshot reuse
    await engine.getOpportunities();
    expect(world.callCounts!.get("tickSpacing")).toBe(reads);
    expect(world.callCounts!.get("slot0")!).toBeGreaterThan(slot0);
    clock.t += 11 * 60_000;
    await engine.getOpportunities({}, { ...(await engine.context()), blockNumber: BLOCK.number + 10n });
    expect(uni.stats).toMatchObject({ fullScans: 1, incrementalScans: 1 });
    void s;
  });

  it("cold event scan is resumable: ≥1 task per run within the budget, progress persisted, sweep pools from run 1", async () => {
    const store = new MemoryPoolListStore();
    const pools = fixtureUniswapPools();
    const world = defaultWorld();
    installUniswap(world, pools);
    const s = await testStack({ world });
    const uni = new UniswapAdapter({ store, now: () => NOW.getTime(), scanBudgetMs: 0 });
    const engine = new OpportunityEngine([uni], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
    const first = await engine.getOpportunities(ALL);
    expect(first.adapters[0]!.status).toBe("PARTIAL");
    expect(first.data.some((o) => o.venue.id === pools.nvdaUsdg!.pool.toLowerCase())).toBe(true);
    const pending0 = store.snapshot!.coldScan!.pending.length;
    expect(pending0).toBeGreaterThan(0);
    let runs = 1;
    while (store.snapshot!.coldScan && runs < 50) {
      // new block each run so the per-block snapshot is not reused
      await engine.getOpportunities(ALL, { ...(await engine.context()), blockNumber: BLOCK.number + BigInt(runs) });
      runs++;
    }
    expect(store.snapshot!.coldScan).toBeNull();
    expect(uni.stats.coldTasksRun).toBe(pending0 + 1);
    const done = await engine.getOpportunities(ALL, { ...(await engine.context()), blockNumber: BLOCK.number + 100n });
    expect(done.data.some((o) => o.venue.id === pools.fakeNvdaAapl!.pool.toLowerCase())).toBe(true); // token×token via events
    expect(store.snapshot!.pools.every((p) => p.via === "EVENT")).toBe(true); // sweep results are not persisted
  });

  it("a timed-out topic set is split by tokens (not by range) until it answers; nothing is lost", async () => {
    const { engine, uni, pools } = await setup({ mutateWorld: (w) => (w.logsTimeoutAbove = 2) });
    const r = await engine.getOpportunities(ALL);
    expect(uni.stats.taskSplits).toBeGreaterThan(0);
    expect(r.data.some((o) => o.venue.id === pools.fakeNvdaAapl!.pool.toLowerCase())).toBe(true);
    expect(r.adapters[0]!.status).toBe("COMPLETE");
  });

  it("a new process reuses the persisted pool list and identity checks within POOL_IDENTITY, then re-verifies", async () => {
    const store = new MemoryPoolListStore();
    const clock = { t: NOW.getTime() };
    await (await setup({ store, clock })).engine.getOpportunities();
    expect(Object.keys(store.snapshot!.identities ?? {}).length).toBeGreaterThan(0);
    const second = await setup({ store, clock });
    await second.engine.getOpportunities();
    expect(second.uni.stats.fullScans).toBe(0);
    expect(second.world.callCounts!.get("factory") ?? 0).toBe(0); // immutable identity reused
    clock.t += 25 * 60 * 60_000; // beyond POOL_IDENTITY (24 h)
    const third = await setup({ store, clock });
    await third.engine.getOpportunities();
    expect(third.world.callCounts!.get("factory")).toBeGreaterThan(0); // re-verified onchain
  });

  it("secondary pools (a non-registry token) reuse state up to POOL_STATE_SECONDARY, labelled with its block; primary pools are read every block", async () => {
    const clock = { t: NOW.getTime() };
    const { engine, uni, pools } = await setup({ clock });
    await engine.getOpportunities(ALL);
    const reads1 = uni.stats.stateReads!;
    clock.t += 20_000;
    const r2 = await engine.getOpportunities(ALL, { ...(await engine.context()), blockNumber: BLOCK.number + 5n });
    const primaryCount = r2.data.filter((o) => o.trade && o.trade.market.assets.every((a) => a.canonical)).length / 2;
    expect(uni.stats.stateReads! - reads1).toBe(primaryCount);
    const fake = tradeFor(r2.data, pools.fakeNvdaAapl!, AAPL)!;
    expect(fake.trade!.market.price!.value.source.blockNumber).toBe(BLOCK.number); // reused, labelled
    const real = tradeFor(r2.data, pools.nvdaUsdg!, NVDA)!;
    expect(real.trade!.market.price!.value.source.blockNumber).toBe(BLOCK.number + 5n);
  });

  it("one broken pool (unreadable state) does not stop the adapter", async () => {
    const { engine, pools } = await setup({ mutateWorld: (w) => w.contracts!.set(pools_nvdaWethAddr(), { ...w.contracts!.get(pools_nvdaWethAddr()), slot0: "revert" }) });
    const r = await engine.getOpportunities(ALL);
    expect(r.status).toBe("PARTIAL");
    const bad = tradeFor(r.data, pools.nvdaWeth!, NVDA)!;
    expect(bad.trade!.market.state).toBe("UNREADABLE");
    expect(bad.eligibility!.excludedBy).toContain("ENTRY_STATE_UNKNOWN");
    expect(tradeFor(r.data, pools.nvdaUsdg!, NVDA)!.trade!.market.state).toBe("ACTIVE");
  });
});
const pools_nvdaWethAddr = () => fixtureUniswapPools().nvdaWeth!.pool.toLowerCase();

describe("asset identity (addresses only)", () => {
  it("a token with symbol 'NVDA' that is not the registry NVDA is never canonical NVDA", async () => {
    const { engine, pools } = await setup();
    const all = (await engine.getOpportunities(ALL)).data;
    const fake = all.filter((o) => o.venue.id === pools.fakeNvdaAapl!.pool.toLowerCase());
    const fakeSide = fake.find((o) => o.primaryAsset.address.toLowerCase() === FAKE_NVDA.toLowerCase())!;
    expect(fakeSide.primaryAsset).toMatchObject({ symbol: "NVDA", canonical: false });
    expect(fakeSide.primaryAsset.key).not.toBe(K(NVDA));
    expect(fakeSide.warnings.map((w) => w.code)).toContain("LOOKALIKE_TOKEN");
    expect(fake.every((o) => o.eligibility!.excludedBy.includes("UNVERIFIED_ASSET"))).toBe(true);
    const nvda = await engine.getAssetOpportunities(K(NVDA), ALL);
    expect(nvda.data.some((o) => o.venue.id === pools.fakeNvdaAapl!.pool.toLowerCase())).toBe(false);
  });

  it("a fake 'USDG' paired with real NVDA is never a route to USDG", async () => {
    const { engine, pools } = await setup();
    const routes = await engine.getTradeRoutes(K(NVDA), K(USDG));
    const used = [...routes.data.direct, ...routes.data.oneHop].flatMap((r) => r.hops.map((h) => h.marketId));
    expect(used.some((id) => id.endsWith(pools.fakeUsdgNvda!.pool.toLowerCase()))).toBe(false);
    expect(routes.data.rejected.find((x) => x.marketId.endsWith(pools.fakeUsdgNvda!.pool.toLowerCase()))?.reason).toBe("ASSET_NOT_CANONICAL");
    const o = tradeFor((await engine.getOpportunities(ALL)).data, pools.fakeUsdgNvda!, NVDA)!;
    expect(o.outputAssets[0]).toMatchObject({ symbol: "USDG", canonical: false });
    expect(o.outputAssets[0]!.address).toBe(UNKNOWN_FAKE_USDG);
  });
});

describe("pool state, price, liquidity and TVL", () => {
  it("DEX price from sqrtPriceX96 is exact and separate from the portfolio price", async () => {
    const { engine, pools } = await setup();
    const m = tradeFor((await engine.getOpportunities()).data, pools.nvdaUsdg!, NVDA)!.trade!.market;
    expect(m.price!.kind).toBe("DEX_MARKET_PRICE");
    expect(m.price!.value.value).toBe(price0In1(pools.nvdaUsdg!.sqrtPriceX96, 18, 6));
    // ≈ 224.41382169 / 1.00009 = 224.393626…
    expect(m.price!.value.value / 10n ** 12n).toBe(224_393_626n); // 224.41382169 / 1.00009 = 224.3936262… (Python Decimal)
    expect(m.priceInverse!.value.value).toBe(price1In0(pools.nvdaUsdg!.sqrtPriceX96, 18, 6));
    expect(m.warnings.map((w) => w.code)).not.toContain("MARKET_PRICE_DIVERGENCE");
  });

  it("a DEX price far from the portfolio price is a typed divergence warning, nothing is overwritten", async () => {
    const pools = fixtureUniswapPools();
    pools.nvdaUsdg!.sqrtPriceX96 = (pools.nvdaUsdg!.sqrtPriceX96 * 105n) / 100n; // ≈ +10% price
    const { engine } = await setup({ pools });
    const o = tradeFor((await engine.getOpportunities()).data, pools.nvdaUsdg!, NVDA)!;
    const w = o.warnings.find((x) => x.code === "MARKET_PRICE_DIVERGENCE")!;
    expect(w.message).toMatch(/neither is declared correct/);
    expect(w.details).toHaveProperty("dexPrice");
    expect(w.details).toHaveProperty("portfolioPrice");
  });

  it("TVL = Σ balances × Phase 1 prices with provenance; reserves typed separately from active liquidity", async () => {
    const { engine, pools } = await setup();
    const m = tradeFor((await engine.getOpportunities()).data, pools.nvdaUsdg!, NVDA)!.trade!.market;
    const nvdaUsd = (10_000n * 22_441_382_169n * 10n ** 10n); // 10,000 NVDA × $224.41382169 (1e18)
    const usdgUsd = (2_244_000n * 100_009_000n * 10n ** 10n); // 2,244,000 USDG × $1.00009
    expect(m.liquidity.tvl!.value.e18).toBe(nvdaUsd + usdgUsd);
    expect(m.liquidity.tvl!.formula).toMatch(/balanceOf/);
    expect(m.liquidity.reserves.map((r) => r.value.amount!.raw)).toEqual([10_000n * ONE, 2_244_000n * 10n ** 6n]);
    expect(m.liquidity.activeLiquidity!.value).toBe(10n ** 20n);
    expect(m.liquidity.activeLiquidityMeaning).toMatch(/not a token or USD amount/);
    expect(m.volume24h.status).toBe("UNKNOWN"); // P4-5: never estimated, never 0
  });

  it("an unpriced token ⇒ TVL unknown (never $0) ⇒ LIQUIDITY_UNVERIFIED hides it by default", async () => {
    const { engine, pools } = await setup();
    const o = tradeFor((await engine.getOpportunities(ALL)).data, pools.unpriced!, USDG)!;
    expect(o.trade!.market.liquidity.tvl).toBeNull();
    expect(o.warnings.map((w) => w.code)).toContain("UNPRICED_METRIC");
    expect(o.eligibility!.excludedBy).toEqual(["LIQUIDITY_UNVERIFIED"]);
  });

  it("zero in-range liquidity ⇒ NO_ACTIVE_LIQUIDITY, INACTIVE, not a routing edge", async () => {
    const { engine, pools } = await setup();
    const o = tradeFor((await engine.getOpportunities(ALL)).data, pools.zeroLiquidity!, USDG)!;
    expect(o.trade!.market.state).toBe("NO_ACTIVE_LIQUIDITY");
    expect(o.lifecycle.state).toBe("INACTIVE");
    expect(o.eligibility!.excludedBy).toContain("INACTIVE");
  });

  it("a $0.33 pool is DUST: discoverable in the full view, not in the default view, not an edge", async () => {
    const { engine, pools } = await setup();
    const all = (await engine.getOpportunities(ALL)).data;
    const o = tradeFor(all, pools.aaplDust!, AAPL)!;
    expect(o.eligibility!.excludedBy).toEqual(["DUST_LIQUIDITY"]);
    expect((await engine.getOpportunities()).data.some((x) => x.id === o.id)).toBe(false);
    const g = buildTradeGraph((await engine.getTradeMarkets()).data);
    expect(g.rejected.find((x) => x.marketId === o.trade!.market.id)?.reason).toBe("DUST");
  });
});

describe("direct and one-hop routing (generic graph)", () => {
  it("getAssetOpportunities(NVDA) returns verified DIRECT TRADE opportunities", async () => {
    const { engine, pools } = await setup();
    const r = await engine.getAssetOpportunities(K(NVDA), { filter: { categories: ["TRADE"] } });
    expect(r.data.map((o) => o.venue.id).sort()).toEqual([pools.nvdaUsdg!.pool, pools.nvdaWeth!.pool].map((a) => a.toLowerCase()).sort());
    const o = r.data.find((x) => x.outputAssets[0]!.address === USDG)!;
    expect(o.trade!.route).toMatchObject({ kind: "DIRECT", hops: [{ from: { address: NVDA }, to: { address: USDG } }] });
    expect(o.entry).toMatchObject({ kind: "DIRECT", steps: [{ action: "SWAP", verified: true }] });
    expect(o.yields).toEqual([]); // TRADE never carries an APY
  });

  it("finds DIRECT and ONE_HOP (via allowlisted WETH) routes, ordered by bottleneck TVL, no cycles", async () => {
    const { engine, pools } = await setup();
    const r = (await engine.getTradeRoutes(K(NVDA), K(USDG))).data;
    expect(r.direct).toHaveLength(1);
    expect(r.oneHop).toHaveLength(1);
    const hop = r.oneHop[0]!;
    expect(hop.kind).toBe("ONE_HOP");
    expect(hop.intermediates.map((a) => a.address)).toEqual([WETH]);
    expect(hop.hops.map((h) => h.marketId.split(":").pop())).toEqual([pools.nvdaWeth!.pool.toLowerCase(), pools.wethUsdg!.pool.toLowerCase()]);
    expect(hop.properties).toMatchObject({ hopCount: 2, allMarketsVerified: true, allAssetsCanonical: true, protocols: ["uniswap"] });
    // combined fee 1 − (1−0.0005)(1−0.0001) = 599.95 ppm; the kept share is floored, so the fee rounds up (600)
    expect(hop.properties.combinedFeePpm).toBe(600);
    expect(r.ordering).toBe("BOTTLENECK_TVL_DESC");
  });

  it("routes never pass through the endpoints themselves; >1 intermediate is not supported", async () => {
    const { engine } = await setup();
    const g = buildTradeGraph((await engine.getTradeMarkets()).data);
    const toWeth = findRoutes(g, K(NVDA), K(WETH));
    expect(toWeth.oneHop.every((r) => r.intermediates.every((a) => a.key !== K(WETH) && a.key !== K(NVDA)))).toBe(true);
    const direct1 = findRoutes(g, K(NVDA), K(USDG), { routingAssetKeys: [K(USDG), K(WETH)], maxHops: 1, minEdgeTvlUsdE18: 0n });
    expect(direct1.oneHop).toEqual([]);
    expect(findRoutes(g, K(NVDA), K(NVDA))).toMatchObject({ direct: [], oneHop: [] });
    expect([...toWeth.direct, ...toWeth.oneHop].every((r) => r.hops.length <= 2)).toBe(true);
  });

  it("route ids are unique (dedupe) and ordering is deterministic", async () => {
    const { engine } = await setup();
    const markets = (await engine.getTradeMarkets()).data;
    const g = buildTradeGraph([...markets, ...markets]);
    const a = findRoutes(g, K(NVDA), K(USDG));
    const b = findRoutes(g, K(NVDA), K(USDG));
    expect(new Set([...a.direct, ...a.oneHop].map((r) => r.id)).size).toBe(a.direct.length + a.oneHop.length);
    expect(a.direct.map((r) => r.id)).toEqual(b.direct.map((r) => r.id));
  });

  it("destinations: direct and additional one-hop destinations from the graph", async () => {
    const { engine } = await setup();
    const g = buildTradeGraph((await engine.getTradeMarkets()).data);
    const d = destinations(g, K(NVDA));
    expect(d.direct).toEqual([K(USDG), K(WETH)].sort());
    expect(d.oneHop).toEqual([]); // everything reachable in one hop is already direct here
  });
});

describe("indicative quotes", () => {
  const route = async (engine: OpportunityEngine, kind: "DIRECT" | "ONE_HOP") => {
    const r = (await engine.getTradeRoutes(K(NVDA), K(USDG))).data;
    return kind === "DIRECT" ? r.direct[0]! : r.oneHop[0]!;
  };

  it("explicit amount → INDICATIVE_QUOTE with expected output, effective price, fees, impact, block, provenance", async () => {
    const { engine, pools } = await setup();
    const q = await engine.getTradeQuote(await route(engine, "DIRECT"), 100n * ONE);
    if (!q.ok) throw new Error(q.reason);
    const quote: TradeQuote = q.quote;
    expect(quote.kind).toBe("INDICATIVE_QUOTE");
    const p = pools.nvdaUsdg!;
    const sq = p.sqrtPriceX96 * p.sqrtPriceX96;
    const expected = ((((100n * ONE * 999_500n) / 1_000_000n) * sq) / Q192 * p.depth0) / (p.depth0 + 100n * ONE);
    expect(quote.expectedOutput.raw).toBe(expected);
    expect(quote.fees).toEqual([{ hop: 0, asset: expect.objectContaining({ address: NVDA }), amount: { raw: 5n * 10n ** 16n, decimals: 18, display: "0.05" } }]);
    // model impact = in/(D+in) = 100/20100 ≈ 0.4975%
    expect(Number(quote.priceImpact!) / 1e18).toBeCloseTo(100 / 20_100, 6);
    expect(quote.blockNumber).toBe(BLOCK.number);
    expect(quote.source).toMatchObject({ type: "ONCHAIN", method: expect.stringMatching(/QuoterV2/) });
    expect(quote.warnings.map((w) => w.code)).toEqual(["INDICATIVE_QUOTE"]);
    const keys: string[] = [];
    JSON.stringify(quote, (k, v) => (keys.push(k), typeof v === "bigint" ? v.toString() : v));
    expect(keys.filter((k) => /min|calldata|deadline|slippage|data$/i.test(k))).toEqual([]);
    expect(quote.effectivePrice).toBe((quote.expectedOutput.raw * 10n ** 30n) / (100n * ONE)); // 18 + 18 − 6
  });

  it("one-hop quote chains hop outputs; fees per hop in each hop's input asset", async () => {
    const { engine, control } = await setup();
    const q = await engine.getTradeQuote(await route(engine, "ONE_HOP"), ONE);
    if (!q.ok) throw new Error(q.reason);
    expect(control.quoteCalls).toBe(2);
    expect(q.quote.fees!.map((f) => f.asset.address)).toEqual([NVDA, WETH]);
    expect(q.quote.expectedOutput.asset.address).toBe(USDG);
    expect(q.quote.priceImpact).not.toBeNull();
  });

  it("tiny and large amounts: 1 wei quotes (integer precision kept); beyond pool balance is a failure, not a number", async () => {
    const { engine } = await setup();
    const r = await route(engine, "DIRECT");
    const tiny = await engine.getTradeQuote(r, 1n);
    expect(tiny.ok).toBe(true);
    if (tiny.ok) expect(tiny.quote.expectedOutput.raw).toBe(0n);
    const huge = await engine.getTradeQuote(r, 10n ** 9n * ONE);
    expect(huge).toMatchObject({ ok: false, retryable: false });
    const zero = await engine.getTradeQuote(r, 0n);
    expect(zero).toMatchObject({ ok: false });
  });

  it("quote failure (revert) and quote timeout are reported, never thrown or invented", async () => {
    const { engine, control } = await setup();
    const r = await route(engine, "DIRECT");
    control.quoteFails = "revert";
    expect(await engine.getTradeQuote(r, ONE)).toMatchObject({ ok: false, retryable: false });
    const slow = await setup({ quoteTimeoutMs: 50 });
    const r2 = await route(slow.engine, "DIRECT");
    const orig = slow.s.reader.readContract.bind(slow.s.reader) as (c: never, o: never) => Promise<unknown>;
    slow.s.reader.readContract = (async (c: never, o: never) => {
      await new Promise((res) => setTimeout(res, 200));
      return orig(c, o);
    }) as typeof slow.s.reader.readContract;
    expect(await slow.engine.getTradeQuote(r2, ONE)).toMatchObject({ ok: false, retryable: true, reason: expect.stringMatching(/timed out/) });
  });

  it("quotes are short-lived cache entries per (route, amount, block)", async () => {
    const clock = { t: NOW.getTime() };
    const { engine, control } = await setup({ clock });
    const r = await route(engine, "DIRECT");
    await engine.getTradeQuote(r, ONE);
    await engine.getTradeQuote(r, ONE);
    expect(control.quoteCalls).toBe(1);
    await engine.getTradeQuote(r, 2n * ONE);
    expect(control.quoteCalls).toBe(2);
    clock.t += 6_000; // beyond QUOTE; also beyond nothing else: same block
    await engine.getTradeQuote(r, ONE);
    expect(control.quoteCalls).toBe(3);
  });

  it("quotes are refused for non-canonical or unverified markets (no untrusted token code is simulated)", async () => {
    const { engine, uni, pools } = await setup();
    const all = (await engine.getOpportunities(ALL)).data;
    const fake = tradeFor(all, pools.fakeUsdgNvda!, NVDA)!;
    const ctx = await engine.context();
    expect(await uni.quoteRoute(fake.trade!.route, ONE, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/canonical/) });
    const broken = tradeFor(all, pools.broken!, NVDA)!;
    expect(await uni.quoteRoute(broken.trade!.route, ONE, ctx)).toMatchObject({ ok: false, reason: expect.stringMatching(/not verified/) });
  });

  it("quotes compare only for the same input asset, output asset and amount", async () => {
    const { engine } = await setup();
    const a = await engine.getTradeQuote(await route(engine, "DIRECT"), ONE);
    const b = await engine.getTradeQuote(await route(engine, "ONE_HOP"), ONE);
    const c = await engine.getTradeQuote(await route(engine, "DIRECT"), 2n * ONE);
    if (!a.ok || !b.ok || !c.ok) throw new Error("quotes");
    expect(quotesComparable(a.quote, b.quote)).toEqual({ comparable: true });
    expect(quotesComparable(a.quote, c.quote)).toMatchObject({ comparable: false, reason: "different input amounts" });
    expect(orderQuotesByOutput([b.quote, a.quote])[0]!.expectedOutput.raw).toBeGreaterThanOrEqual(orderQuotesByOutput([b.quote, a.quote])[1]!.expectedOutput.raw);
    expect(() => orderQuotesByOutput([a.quote, c.quote])).toThrow(/not comparable/);
  });

  it("price-impact math is exact on rationals (fees excluded)", () => {
    const sq = 2n ** 96n; // price 1
    const spot = hopSpotRational(sq, true);
    // out equals the fee-adjusted ideal → zero impact
    expect(priceImpact(1_000_000n, 997_000n, [{ spot, feePpm: 3000 }])).toBe(0n);
    expect(priceImpact(1_000_000n, 897_300n, [{ spot, feePpm: 3000 }])).toBe(10n ** 17n); // 10% below ideal
    expect(priceImpact(1n, 0n, [{ spot: { num: 0n, den: 1n }, feePpm: 0 }])).toBeNull();
  });
});

describe("eligibility, filters and comparison for TRADE", () => {
  it("default TRADE view: verified origin, canonical in/out, non-dust, readable, active, not conflicted", async () => {
    const { engine } = await setup();
    const def = (await engine.getOpportunities({ filter: { categories: ["TRADE"] } })).data;
    expect(def.length).toBeGreaterThan(0);
    for (const o of def) {
      expect(o.trade!.market.originVerified).toBe(true);
      expect(o.risk.allAssetsCanonical).toBe(true);
      expect(o.trade!.market.state).toBe("ACTIVE");
      expect(o.trade!.market.liquidity.tvl!.value.e18).toBeGreaterThanOrEqual(50n * ONE);
    }
    const all = await engine.getOpportunities({ ...ALL, filter: { categories: ["TRADE"] } });
    expect(all.data.length).toBeGreaterThan(def.length);
  });

  it("filters: protocol + category + asset; TVL sort works on TRADE; YIELD sort never ranks TRADE", async () => {
    const { engine } = await setup({ protocols: ["morpho", "uniswap"] });
    const r = await engine.getAssetOpportunities(K(USDG), { filter: { protocols: ["uniswap"], categories: ["TRADE"] }, sort: { by: "TVL_USD", direction: "DESC" } });
    expect(r.data.every((o) => o.protocol.id === "uniswap" && o.category === "TRADE" && o.primaryAsset.key === K(USDG))).toBe(true);
    const y = await engine.getAssetOpportunities(K(USDG), { sort: { by: "YIELD", yieldType: "SUPPLY_APY", direction: "DESC" } });
    const ranked = y.data.slice(0, y.data.length - y.notComparable!.length);
    expect(ranked.some((o) => o.category === "TRADE")).toBe(false);
  });
});

describe("three-protocol aggregation and failure isolation", () => {
  it("NVDA: Morpho COLLATERAL + Pendle FIXED_YIELD/LP + Uniswap TRADE through one engine, no protocol branching", async () => {
    const { engine } = await setup({ protocols: ["morpho", "pendle", "uniswap"] });
    const r = await engine.getAssetOpportunities(K(NVDA));
    const cats = new Set(r.data.map((o) => `${o.protocol.id}:${o.category}`));
    for (const c of ["morpho:COLLATERAL", "pendle:FIXED_YIELD", "pendle:LP", "uniswap:TRADE"]) expect(cats.has(c)).toBe(true);
    expect(r.status).toBe("COMPLETE");
  });

  const failing = (id: string): OpportunityAdapter => ({
    protocol: { id, name: id },
    categories: ["TRADE"],
    capabilities: { discovery: true, assetFiltering: false, userPositions: false, singleOpportunity: false, execution: false },
    supportsCategory: () => true,
    getOpportunities: async () => {
      throw new Error(`${id} down`);
    },
  });

  it("pool-event scan failing ⇒ Uniswap PARTIAL but still serves the factory-sweep pools", async () => {
    const { engine, pools } = await setup({ mutateWorld: (w) => (w.logsFail = true) });
    const r = await engine.getOpportunities(ALL);
    expect(r.adapters[0]!.status).toBe("PARTIAL");
    expect(r.warnings.map((w) => w.code)).toContain("MARKET_DISCOVERY_DEGRADED");
    const ids = new Set(r.data.map((o) => o.venue.id));
    expect(ids.has(pools.nvdaUsdg!.pool.toLowerCase())).toBe(true); // token×hub: found by getPool
    expect(ids.has(pools.fakeNvdaAapl!.pool.toLowerCase())).toBe(false); // token×token: needs the event scan
  });

  it("Uniswap adapter failing ⇒ PARTIAL with Morpho + Pendle preserved", async () => {
    const { s } = await setup({ protocols: ["morpho", "pendle"] });
    const mm = fixtureMarkets();
    const pm = fixturePendleMarkets();
    const engine = new OpportunityEngine(
      [new MorphoAdapter(s.http, { api: new FakeMorphoApi(Object.values(mm).map((m) => m.apiRaw)), now: () => NOW.getTime() }), new PendleAdapter(s.http, { api: new FakePendleApi(pm), now: () => NOW.getTime() }), failing("uniswap")],
      { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now },
    );
    const r = await engine.getOpportunities();
    expect(r.adapters.find((a) => a.protocol === "uniswap")!.status).toBe("UNKNOWN");
    expect(r.adapters.find((a) => a.protocol === "morpho")!.status).toBe("COMPLETE");
    expect(r.adapters.find((a) => a.protocol === "pendle")!.status).toBe("COMPLETE");
    expect(r.status).toBe("PARTIAL");
    expect(r.data.some((o) => o.protocol.id === "morpho") && r.data.some((o) => o.protocol.id === "pendle")).toBe(true);
  });

  it("Morpho failed, Pendle + Uniswap healthy ⇒ PARTIAL; only Uniswap healthy ⇒ its opportunities still returned; all failed ⇒ UNKNOWN", async () => {
    const { s, uni } = await setup({ protocols: ["pendle", "uniswap"] });
    const pm = fixturePendleMarkets();
    const mk = (adapters: OpportunityAdapter[]) => new OpportunityEngine(adapters, { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
    const pendle = new PendleAdapter(s.http, { api: new FakePendleApi(pm), now: () => NOW.getTime() });
    const a = await mk([failing("morpho"), pendle, uni]).getOpportunities();
    expect(a.status).toBe("PARTIAL");
    expect(a.data.some((o) => o.protocol.id === "uniswap") && a.data.some((o) => o.protocol.id === "pendle")).toBe(true);
    const b = await mk([failing("morpho"), failing("pendle"), uni]).getOpportunities();
    expect(b.status).toBe("PARTIAL");
    expect(b.data.length).toBeGreaterThan(0);
    expect(b.data.every((o) => o.protocol.id === "uniswap")).toBe(true);
    const c = await mk([failing("morpho"), failing("pendle"), failing("uniswap")]).getOpportunities();
    expect(c.status).toBe("UNKNOWN");
    expect(c.data).toEqual([]);
  });
});

describe("wallet → trade opportunities", () => {
  it("NVDA holder: TRADE context with held amount/value and destinations; nothing quoted automatically", async () => {
    const { s, engine, control } = await setup({ protocols: ["morpho", "pendle", "uniswap"] });
    const portfolio = await getPortfolio(WALLET, s.deps);
    const res = await engine.getPortfolioOpportunities(portfolio);
    const nv = res.data.find((g) => g.assetKey === K(NVDA))!;
    const trades = nv.items.filter((p) => p.opportunity.category === "TRADE");
    expect(trades.length).toBe(2);
    const t = trades.find((p) => p.context.kind === "TRADE" && p.context.to.address === USDG)!;
    expect(t.context).toMatchObject({ kind: "TRADE", held: { amount: { raw: 2n * ONE } }, routeKind: "DIRECT" });
    expect(t.context.kind === "TRADE" && t.context.held.usd).not.toBeNull();
    expect(nv.tradeDestinations.direct).toEqual([K(USDG), K(WETH)].sort());
    expect(control.quoteCalls).toBe(0);
  });
});

describe("financial integer precision", () => {
  it("prices for 18/6-decimal pairs stay exact across the inversion", () => {
    const p = fixtureUniswapPools().nvdaUsdg!;
    const a = price0In1(p.sqrtPriceX96, 18, 6);
    const b = price1In0(p.sqrtPriceX96, 18, 6)!;
    // a·b ≈ 1e36 within floor error of both sides
    const prod = a * b;
    expect(prod <= 10n ** 36n).toBe(true);
    expect(10n ** 36n - prod < 10n ** 36n / 10n ** 12n).toBe(true);
  });
});
