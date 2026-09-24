/**
 * Opportunity Engine + Morpho adapter end-to-end on the offline fixture world.
 * Also proves a second protocol can be plugged in without touching the engine.
 */
import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import type { Opportunity } from "../../src/model/opportunity.js";
import type { AdapterContext, OpportunityAdapter } from "../../src/opportunities/adapter.js";
import { OpportunityEngine } from "../../src/opportunities/engine.js";
import { filterOpportunities, sortOpportunities } from "../../src/opportunities/query.js";
import { getPortfolio } from "../../src/portfolio/engine.js";
import { MorphoAdapter } from "../../src/protocols/morpho/adapter.js";
import { marketIdOf } from "../../src/protocols/morpho/onchain.js";
import { FAKE_NVDA, FakeMorphoApi, fixtureMarkets, installMorpho, LLTV_625, NVDA_USDG_ORACLE, VAULT_OK, VAULT_ROGUE } from "../fixtures/morpho.js";
import { AAPL, defaultWorld, NOW, NVDA, testStack, USDG, WALLET } from "../fixtures/world.js";

async function setup(opts: { markets?: ReturnType<typeof fixtureMarkets>; apiMarkets?: unknown[]; mutateWorld?: (w: ReturnType<typeof defaultWorld>) => void; clock?: { t: number } } = {}) {
  const markets = opts.markets ?? fixtureMarkets();
  const world = defaultWorld();
  installMorpho(world, markets);
  opts.mutateWorld?.(world);
  const s = await testStack({ world });
  const api = new FakeMorphoApi(opts.apiMarkets ?? Object.values(markets).map((m) => m.apiRaw));
  const clock = opts.clock ?? { t: NOW.getTime() };
  const adapter = new MorphoAdapter(s.http, { api, now: () => clock.t });
  const engine = new OpportunityEngine([adapter], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
  return { s, api, adapter, engine, world, markets, clock };
}

const idOf = (m: { params: Parameters<typeof marketIdOf>[0] }) => marketIdOf(m.params);
const find = (list: Opportunity[], category: string, marketId: string) => list.find((o) => o.category === category && o.venue.id === marketId)!;

describe("Morpho market normalization (through the adapter)", () => {
  it("creates COLLATERAL (NVDA → borrow USDG) and LEND (USDG) opportunities with typed yields", async () => {
    const { engine, markets } = await setup();
    const r = await engine.getOpportunities();
    const id = idOf(markets.nvdaOk);
    const coll = find(r.data, "COLLATERAL", id);
    const lend = find(r.data, "LEND", id);
    expect(coll.id).toBe(`4663:morpho:COLLATERAL:market:${id}`);
    expect(coll.primaryAsset).toMatchObject({ address: NVDA, canonical: true, registryType: "STOCK_TOKEN" });
    expect(coll.borrowAssets[0]).toMatchObject({ address: USDG, canonical: true });
    expect(lend.primaryAsset.address).toBe(USDG);
    // yield semantics: borrow cost is PAY, supply is EARN; values exactly from the API floats
    expect(coll.yields.find((y) => y.type === "BORROW_APY")).toMatchObject({ side: "PAY", value: 45_389_470_000_000_000n, origin: "SUPPLIED", compounding: "COMPOUNDED" });
    expect(lend.yields.find((y) => y.type === "SUPPLY_APY")).toMatchObject({ side: "EARN", value: 40_900_000_000_000_000n });
    expect(lend.yields.find((y) => y.type === "REWARD_APY")).toMatchObject({ side: "EARN", compounding: "SIMPLE", value: 10n ** 16n });
    expect(lend.yields.some((y) => y.type === "BORROW_APY")).toBe(false);
    // onchain totals, computed utilization and liquidity
    expect(lend.utilization?.value).toBe(6n * 10n ** 17n); // 60 / 100
    expect(lend.availableLiquidity?.value.amount.raw).toBe(40_000_000_000n);
    expect(lend.availableLiquidity?.origin).toBe("COMPUTED");
    expect(lend.tvl?.value.usd?.display).toBe("100009"); // 100,000 USDG × 1.00009 via Price Service
    // liquidation terms from onchain params + Morpho formula
    expect(coll.liquidation?.lltv).toMatchObject({ value: LLTV_625, verification: "VERIFIED_ONCHAIN" });
    expect(coll.liquidation?.liquidationIncentiveFactor?.value).toBe(1_126_760_563_380_281_690n);
    expect(coll.liquidation?.collateralPrice?.value).toEqual({ raw: NVDA_USDG_ORACLE, scale: 10n ** 36n });
    expect(coll.risk.oracle?.multiplierCheck).toBe("CONSISTENT");
    expect(coll.verificationStatus).toBe("VERIFIED_OFFICIAL_API"); // weakest: API yields
  });

  it("provenance: yields cite the Morpho API with its state timestamp; LLTV cites the chain with a block", async () => {
    const { engine, markets } = await setup();
    const coll = find((await engine.getOpportunities()).data, "COLLATERAL", idOf(markets.nvdaOk));
    const apy = coll.yields.find((y) => y.type === "BORROW_APY")!;
    expect(apy.source).toMatchObject({ type: "OFFICIAL_API", provider: "morpho-api", method: "state.borrowApy" });
    expect(apy.observedAt).toBe(new Date(NOW.getTime() - 600_000).toISOString());
    expect(apy.freshness).toMatchObject({ status: "FRESH", ageSeconds: 600, rule: "PROTOCOL_API_MARKET_STATE" });
    expect(coll.liquidation!.lltv.source).toMatchObject({ type: "ONCHAIN", method: "idToMarketParams(id)", blockNumber: 71_000_000n });
    expect(coll.provenance.map((p) => p.method)).toEqual(expect.arrayContaining(["idToMarketParams(id)", "market(id)", "price()"]));
  });

  it("flags the double-applied multiplier oracle as CONFLICT (never a normal verified opportunity)", async () => {
    const { engine, markets } = await setup();
    const coll = find((await engine.getOpportunities()).data, "COLLATERAL", idOf(markets.nvdaDouble));
    expect(coll.risk.oracle?.multiplierCheck).toBe("DOUBLE_APPLIED");
    expect(coll.verificationStatus).toBe("CONFLICT");
    expect(coll.warnings.map((w) => w.code)).toContain("ORACLE_MULTIPLIER_DOUBLE_APPLIED");
  });

  it("joins assets by address: a look-alike 'NVDA' is non-canonical, UNVERIFIED and not an NVDA opportunity", async () => {
    const { engine, markets } = await setup();
    const all = await engine.getOpportunities();
    const fake = find(all.data, "COLLATERAL", idOf(markets.fake));
    expect(fake.primaryAsset).toMatchObject({ address: FAKE_NVDA, symbol: "NVDA", canonical: false, registryType: null });
    expect(fake.verificationStatus).toBe("UNVERIFIED");
    expect(fake.warnings.map((w) => w.code)).toContain("LOOKALIKE_TOKEN");
    const nvda = await engine.getAssetOpportunities(`4663:${NVDA.toLowerCase()}`);
    expect(nvda.data.some((o) => o.venue.id === idOf(markets.fake))).toBe(false);
  });

  it("skips idle markets and reports why; 100 % utilization and zero liquidity are warnings, not errors", async () => {
    const { engine, markets } = await setup();
    const r = await engine.getOpportunities();
    expect(r.data.some((o) => o.venue.id === idOf(markets.idle))).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain("MARKET_SKIPPED");
    const full = find(r.data, "LEND", idOf(markets.full));
    expect(full.utilization?.value).toBe(10n ** 18n);
    expect(full.availableLiquidity?.value.amount.raw).toBe(0n);
    expect(full.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["FULL_UTILIZATION", "ZERO_LIQUIDITY", "ORACLE_UNREADABLE"]));
    expect(find(r.data, "COLLATERAL", idOf(markets.full)).liquidation?.collateralPrice).toBeNull();
  });

  it("API/onchain identity conflict: both values surfaced, onchain kept, opportunity CONFLICT", async () => {
    const m = fixtureMarkets();
    const api = Object.values(m).map((x) => x.apiRaw);
    const tampered = { ...m.nvdaOk.apiRaw, collateralAsset: { address: AAPL, symbol: "AAPL", decimals: 18 } };
    const { engine } = await setup({ markets: m, apiMarkets: [tampered, ...api.slice(1)] });
    const coll = find((await engine.getOpportunities()).data, "COLLATERAL", idOf(m.nvdaOk));
    expect(coll.primaryAsset.address).toBe(NVDA); // onchain
    const c = coll.conflicts.find((x) => x.field === "collateralToken")!;
    expect(c.values.map((v) => [v.value.toLowerCase(), v.source.type])).toEqual([[AAPL.toLowerCase(), "OFFICIAL_API"], [NVDA.toLowerCase(), "ONCHAIN"]]);
    expect(coll.verificationStatus).toBe("CONFLICT");
    expect(coll.warnings.map((w) => w.code)).toContain("DATA_CONFLICT");
  });

  it("API totals far from chain → DATA_CONFLICT on totals, onchain value used", async () => {
    const m = fixtureMarkets();
    const stale = { ...m.nvdaOk.apiRaw, state: { ...(m.nvdaOk.apiRaw.state as object), supplyAssets: 1 } };
    const { engine } = await setup({ markets: m, apiMarkets: [stale, ...Object.values(m).slice(1).map((x) => x.apiRaw)] });
    const lend = find((await engine.getOpportunities()).data, "LEND", idOf(m.nvdaOk));
    expect(lend.conflicts.find((c) => c.field === "totalSupplyAssets")?.resolution).toMatch(/onchain value used/);
    expect(lend.tvl?.value.amount.raw).toBe(100_000_000_000n);
  });

  it("missing API state keeps the opportunity (onchain facts) but with no yields; stale state is STALE", async () => {
    const m = fixtureMarkets();
    const noState = { ...m.nvdaOk.apiRaw, state: null };
    const old = { ...m.full.apiRaw, state: { ...(m.full.apiRaw.state as object), timestamp: Math.floor(NOW.getTime() / 1000) - 90_000 } };
    const { engine } = await setup({ markets: m, apiMarkets: [noState, old, m.nvdaDouble.apiRaw] });
    const r = await engine.getOpportunities();
    const lend = find(r.data, "LEND", idOf(m.nvdaOk));
    expect(lend.yields).toEqual([]);
    expect(lend.utilization?.value).toBe(6n * 10n ** 17n);
    const staleOpp = find(r.data, "LEND", idOf(m.full));
    expect(staleOpp.freshness.status).toBe("STALE");
    expect(staleOpp.warnings.map((w) => w.code)).toContain("STALE_PROTOCOL_DATA");
  });

  it("duplicate markets from the API are counted once", async () => {
    const m = fixtureMarkets();
    const { engine } = await setup({ markets: m, apiMarkets: [m.nvdaOk.apiRaw, m.nvdaOk.apiRaw] });
    const r = await engine.getOpportunities();
    expect(r.data.filter((o) => o.venue.id === idOf(m.nvdaOk))).toHaveLength(2); // COLLATERAL + LEND, once each
    expect(r.warnings.map((w) => w.code)).toContain("DUPLICATE_MARKET");
  });

  it("a malformed API market is dropped and the result is PARTIAL, others survive", async () => {
    const m = fixtureMarkets();
    const { engine } = await setup({ markets: m, apiMarkets: [{ marketId: "garbage" }, m.nvdaOk.apiRaw] });
    const r = await engine.getOpportunities();
    expect(r.status).toBe("PARTIAL");
    expect(r.adapters[0]!.issues[0]!.message).toMatch(/malformed item skipped/);
    expect(r.data.length).toBeGreaterThan(0);
  });

  it("unreadable market totals for one market degrade only that market", async () => {
    const m = fixtureMarkets();
    const { engine } = await setup({ markets: m, mutateWorld: (w) => w.morpho!.markets.delete(idOf(m.full).toLowerCase()) });
    const r = await engine.getOpportunities();
    // params unreadable → market not published, others fine
    expect(r.data.some((o) => o.venue.id === idOf(m.full))).toBe(false);
    expect(find(r.data, "LEND", idOf(m.nvdaOk))).toBeTruthy();
    expect(r.warnings.map((w) => w.code)).toContain("MARKET_UNVERIFIED_ONCHAIN");
  });
});

describe("Morpho vaults", () => {
  it("publishes only factory-verified vaults, with onchain TVL and API yields of unknown freshness", async () => {
    const { engine } = await setup();
    const r = await engine.getOpportunities({ filter: { categories: ["VAULT"] } });
    expect(r.data.map((o) => o.venue.address)).toEqual([VAULT_OK]);
    const v = r.data[0]!;
    expect(v.tvl?.value.amount.raw).toBe(150_000_000_000n);
    expect(v.tvl?.source.type).toBe("ONCHAIN");
    expect(v.yields.map((y) => [y.type, y.value])).toEqual([["NET_APY", 39_700_000_000_000_000n], ["BASE_APY", 29_700_000_000_000_000n]]);
    expect(v.yields[0]!.freshness.status).toBe("UNKNOWN");
    expect(v.warnings.map((w) => w.message).join(" ")).toMatch(/deposit_disabled/);
    expect(v.risk.parameterMutability.known).toBe(false);
    expect(r.warnings.map((w) => w.message).join(" ")).toMatch(new RegExp(`vault ${VAULT_ROGUE.slice(0, 10)}`));
  });
});

describe("caching and adapter failure isolation", () => {
  it("immutable params are read once; state is refetched after its TTL", async () => {
    const { engine, world, api, clock } = await setup();
    await engine.getOpportunities();
    const first = world.callCounts!.get("idToMarketParams");
    await engine.getOpportunities();
    expect(world.callCounts!.get("idToMarketParams")).toBe(first); // config cache
    expect(api.calls).toBe(1); // state cache hit within 60 s
    clock.t += 61_000;
    await engine.getOpportunities();
    expect(api.calls).toBe(2);
  });

  it("API outage after a good fetch: last-good state served (PARTIAL, STALE_PROTOCOL_DATA); failures are not cached", async () => {
    const { engine, api, clock } = await setup();
    await engine.getOpportunities();
    api.fail = "all";
    clock.t += 61_000;
    const r = await engine.getOpportunities();
    expect(r.status).toBe("PARTIAL");
    expect(r.warnings.map((w) => w.code)).toContain("STALE_PROTOCOL_DATA");
    expect(r.data.length).toBeGreaterThan(0);
    api.fail = false;
    clock.t += 1;
    await engine.getOpportunities();
    expect(api.calls).toBe(3); // retried immediately: the failure was not cached
  });

  it("API down with no cache: the adapter fails, the engine returns UNKNOWN with ADAPTER_FAILED (no throw)", async () => {
    const { engine, api } = await setup();
    api.fail = "all";
    const r = await engine.getOpportunities();
    expect(r.status).toBe("UNKNOWN");
    expect(r.data).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain("ADAPTER_FAILED");
  });

  it("vault endpoint failure keeps market opportunities (PARTIAL)", async () => {
    const { engine, api } = await setup();
    api.fail = "vaults";
    const r = await engine.getOpportunities();
    expect(r.status).toBe("PARTIAL");
    expect(r.data.some((o) => o.category === "VAULT")).toBe(false);
    expect(r.data.some((o) => o.category === "LEND")).toBe(true);
  });
});

/** A toy second protocol: proves adapters plug in without engine changes. */
class ToyFixedYieldAdapter implements OpportunityAdapter {
  readonly protocol = { id: "toy", name: "Toy" };
  readonly categories = ["FIXED_YIELD"] as const;
  readonly capabilities = { discovery: true, assetFiltering: false, userPositions: false, singleOpportunity: false, execution: false as const };
  constructor(private readonly behaviour: "ok" | "throw" | "duplicate" = "ok", private readonly dupId?: string) {}
  supportsCategory(c: string) {
    return c === "FIXED_YIELD";
  }
  async getOpportunities(ctx: AdapterContext) {
    if (this.behaviour === "throw") throw new Error("toy upstream down");
    const usdg = ctx.registry.get(4663, USDG)!;
    const ref = { key: usdg.key, chainId: 4663, address: USDG as Address, symbol: "USDG", decimals: 6, canonical: true, registryType: "STABLECOIN" };
    const src = { type: "OFFICIAL_API" as const, provider: "toy", observedAt: NOW.toISOString() };
    const fresh = { status: "FRESH" as const, ageSeconds: 0, rule: "PROTOCOL_API_MARKET_STATE" as const };
    const o = {
      id: this.dupId ?? "4663:toy:FIXED_YIELD:pt:0x1",
      chainId: 4663,
      protocol: this.protocol,
      category: "FIXED_YIELD" as const,
      title: "Toy PT-USDG",
      venue: { kind: "TOY", id: "0x1", address: null },
      primaryAsset: ref,
      inputAssets: [ref],
      outputAssets: [ref],
      collateralAssets: [],
      borrowAssets: [],
      yields: [{ type: "IMPLIED_APY" as const, side: "EARN" as const, basis: "IMPLIED" as const, compounding: "COMPOUNDED" as const, window: "to-maturity", denominatedIn: ref, label: "implied", value: 9n * 10n ** 16n, origin: "SUPPLIED" as const, source: src, observedAt: NOW.toISOString(), freshness: fresh, verification: "VERIFIED_OFFICIAL_API" as const }],
      tvl: null,
      availableLiquidity: null,
      utilization: null,
      liquidation: null,
      term: { maturity: "2027-03-25T00:00:00.000Z", lockSeconds: null, withdrawal: "AT_MATURITY" as const },
      contracts: [],
      risk: { oracle: null, lltv: { known: false as const, reason: "n/a" }, utilization: { known: false as const, reason: "n/a" }, availableLiquidityUsd: { known: false as const, reason: "n/a" }, marketSizeUsd: { known: false as const, reason: "n/a" }, rewardDependence: { known: false as const, reason: "n/a" }, parameterMutability: { known: false as const, reason: "n/a" }, protocolListed: { known: false as const, reason: "n/a" }, protocolWarnings: [], allAssetsCanonical: true },
      details: { kind: "MORPHO_VAULT_V2" as const, vault: USDG as Address, name: "n/a", curator: null, totalAssets: null, performanceFee: null, managementFee: null },
      provenance: [src],
      conflicts: [],
      warnings: [],
      freshness: fresh,
      verificationStatus: "VERIFIED_OFFICIAL_API" as const,
      observedAt: NOW.toISOString(),
      generatedAt: NOW.toISOString(),
    } satisfies Opportunity;
    return { data: [o], status: "COMPLETE" as const, issues: [], warnings: [], timingsMs: {} };
  }
}

describe("Opportunity Engine is protocol-agnostic", () => {
  it("a second adapter plugs in; one adapter failing does not stop the other", async () => {
    const { s } = await setup();
    const morpho = new MorphoAdapter(s.http, { api: new FakeMorphoApi(Object.values(fixtureMarkets()).map((m) => m.apiRaw)), now: () => NOW.getTime() });
    const engine = new OpportunityEngine([morpho, new ToyFixedYieldAdapter("throw")], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
    const r = await engine.getOpportunities();
    expect(r.status).toBe("PARTIAL");
    expect(r.adapters.map((a) => [a.protocol, a.status])).toEqual([["morpho", "COMPLETE"], ["toy", "UNKNOWN"]]);
    expect(r.data.length).toBeGreaterThan(0);
  });

  it("duplicate opportunity ids across adapters are kept once and reported", async () => {
    const { s, markets } = await setup();
    const dup = `4663:morpho:LEND:market:${idOf(markets.nvdaOk)}`;
    const engine = new OpportunityEngine(
      [new MorphoAdapter(s.http, { api: new FakeMorphoApi(Object.values(markets).map((m) => m.apiRaw)), now: () => NOW.getTime() }), new ToyFixedYieldAdapter("duplicate", dup)],
      { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now },
    );
    const r = await engine.getOpportunities();
    expect(r.data.filter((o) => o.id === dup)).toHaveLength(1);
    expect(r.data.find((o) => o.id === dup)!.protocol.id).toBe("morpho");
    expect(r.warnings.map((w) => w.code)).toContain("DUPLICATE_OPPORTUNITY_ID");
  });

  it("rejects two adapters with the same protocol id", async () => {
    const { s } = await setup();
    expect(() => new OpportunityEngine([new ToyFixedYieldAdapter(), new ToyFixedYieldAdapter()], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices })).toThrow(/duplicate adapter/);
  });

  it("yield sorting compares one metric type only; others are listed as not comparable", async () => {
    const { s, markets } = await setup();
    const engine = new OpportunityEngine([new MorphoAdapter(s.http, { api: new FakeMorphoApi(Object.values(markets).map((m) => m.apiRaw)), now: () => NOW.getTime() }), new ToyFixedYieldAdapter()], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
    const r = await engine.getAssetOpportunities(`4663:${USDG.toLowerCase()}`, { sort: { by: "YIELD", yieldType: "SUPPLY_APY", direction: "DESC" } });
    const toy = r.data.find((o) => o.protocol.id === "toy")!;
    expect(r.notComparable).toContain(toy.id); // IMPLIED_APY is never ranked against SUPPLY_APY
    expect(r.data.indexOf(toy)).toBeGreaterThan(r.data.findIndex((o) => o.category === "LEND"));
  });
});

describe("filtering and sorting (pure)", () => {
  it("filters by category, asset role, liquidity, TVL, verification and canonical-ness", async () => {
    const { engine, markets } = await setup();
    const all = (await engine.getOpportunities()).data;
    expect(filterOpportunities(all, { categories: ["VAULT"] }).every((o) => o.category === "VAULT")).toBe(true);
    expect(filterOpportunities(all, { assetKey: `4663:${USDG.toLowerCase()}`, assetRole: "BORROW" }).every((o) => o.category === "COLLATERAL")).toBe(true);
    expect(filterOpportunities(all, { minLiquidityUsdE18: 10_000n * 10n ** 18n }).map((o) => o.venue.id)).not.toContain(idOf(markets.full));
    expect(filterOpportunities(all, { minTvlUsdE18: 1n }).every((o) => o.tvl?.value.usd)).toBe(true);
    expect(filterOpportunities(all, { canonicalOnly: true }).some((o) => o.venue.id === idOf(markets.fake))).toBe(false);
    expect(filterOpportunities(all, { verificationStatuses: ["CONFLICT"] }).every((o) => o.verificationStatus === "CONFLICT")).toBe(true);
    expect(filterOpportunities(all, { protocolListedOnly: true }).some((o) => o.venue.id === idOf(markets.nvdaDouble))).toBe(false);
  });

  it("sorting is deterministic; BORROW_APY must be asked for explicitly with a direction", async () => {
    const { engine } = await setup();
    const all = (await engine.getOpportunities()).data;
    const a = sortOpportunities(all, { by: "LIQUIDITY_USD" }).sorted.map((o) => o.id);
    const b = sortOpportunities([...all].reverse(), { by: "LIQUIDITY_USD" }).sorted.map((o) => o.id);
    expect(a).toEqual(b);
    const cheapest = sortOpportunities(all.filter((o) => o.category === "COLLATERAL"), { by: "YIELD", yieldType: "BORROW_APY", direction: "ASC" }).sorted;
    expect(cheapest[0]!.yields.find((y) => y.type === "BORROW_APY")).toBeTruthy();
  });
});

describe("wallet → portfolio → opportunities", () => {
  it("NVDA holder sees COLLATERAL with the protocol maximum borrow (exact integers, labelled as not safe)", async () => {
    const { s, engine, markets } = await setup();
    const portfolio = await getPortfolio(WALLET, s.deps);
    const res = await engine.getPortfolioOpportunities(portfolio);
    const nvdaGroup = res.data.find((g) => g.assetKey === `4663:${NVDA.toLowerCase()}`)!;
    const po = nvdaGroup.items.find((p) => p.opportunity.venue.id === idOf(markets.nvdaOk))!;
    expect(po.context.kind).toBe("COLLATERAL");
    if (po.context.kind !== "COLLATERAL") return;
    // 2 NVDA × oracle / 1e36 × 0.625 — computed with Morpho's own rounding
    const expected = (((2n * 10n ** 18n * NVDA_USDG_ORACLE) / 10n ** 36n) * LLTV_625) / 10n ** 18n;
    expect(po.context.protocolMaximumBorrow?.amount.raw).toBe(expected);
    expect(po.context.protocolMaximumBorrowLiquidityCapped?.amount.raw).toBe(expected < 40_000_000_000n ? expected : 40_000_000_000n);
    expect(po.context.caveat).toMatch(/Not a recommended or safe amount/);
    expect(po.context.protocolMaximumBorrow?.usd).not.toBeNull();
    // opportunities for an asset the wallet does not hold never appear
    expect(res.data.some((g) => g.assetKey === `4663:${AAPL.toLowerCase()}`)).toBe(false);
  });

  it("USDG holder sees LEND and VAULT with supply context; COLLATERAL with an unreadable oracle has no max borrow", async () => {
    const { s, engine, markets } = await setup();
    const portfolio = await getPortfolio(WALLET, s.deps);
    const res = await engine.getPortfolioOpportunities(portfolio);
    const usdg = res.data.find((g) => g.assetKey === `4663:${USDG.toLowerCase()}`)!;
    expect(new Set(usdg.items.map((p) => p.opportunity.category))).toEqual(new Set(["LEND", "VAULT"]));
    const lend = usdg.items.find((p) => p.opportunity.category === "LEND")!;
    expect(lend.context).toMatchObject({ kind: "SUPPLY", suppliable: { amount: { raw: 1_234_560_000n } } });
    void markets;
  });
});

describe("Morpho user positions (onchain scan)", () => {
  it("finds supply, borrow and collateral; converts shares with Morpho rounding; computes Morpho's health factor", async () => {
    const m = fixtureMarkets();
    const id = idOf(m.nvdaOk).toLowerCase();
    const { engine } = await setup({
      markets: m,
      mutateWorld: (w) => {
        w.morpho!.positions.set(`${id}:${WALLET.toLowerCase()}`, { supplyShares: 1_000_000_000_000n, borrowShares: 100_000_000_000_000n, collateral: 2n * 10n ** 18n });
        w.balances.set(VAULT_OK.toLowerCase(), new Map([[WALLET.toLowerCase(), 1_000_000n]]));
      },
    });
    const r = await engine.getUserPositions(WALLET);
    const market = r.data.find((p) => p.kind === "LENDING_MARKET")!;
    // supplied = 1e12 × (1e11 + 1) / (1e17 + 1e6) floored; borrowed rounds up
    expect(market.supplied?.value.amount.raw).toBe((1_000_000_000_000n * (100_000_000_000n + 1n)) / (100_000_000_000_000_000n + 1_000_000n));
    expect(market.borrowed?.value.amount.raw).toBe((100_000_000_000_000n * (60_000_000_000n + 1n) + (60_000_000_000_000_000n + 1_000_000n - 1n)) / (60_000_000_000_000_000n + 1_000_000n));
    const collValue = (2n * 10n ** 18n * NVDA_USDG_ORACLE) / 10n ** 36n;
    expect(market.healthFactor?.value).toBe((collValue * LLTV_625) / market.borrowed!.value.amount.raw);
    expect(market.healthFactor?.formula).toMatch(/Morpho health factor definition/);
    expect(market.liquidatable).toBe(false);
    expect(market.relatedOpportunityIds).toEqual([`4663:morpho:LEND:market:${id}`, `4663:morpho:COLLATERAL:market:${id}`]);
    const vault = r.data.find((p) => p.kind === "VAULT")!;
    expect(vault.shares?.value).toBe(1_000_000n);
    expect(vault.supplied?.value.amount.raw).toBe(1_050_000n);
  });

  it("a wallet with no positions returns an empty, COMPLETE list; invalid input is rejected", async () => {
    const { engine } = await setup();
    const r = await engine.getUserPositions(WALLET);
    expect(r.data).toEqual([]);
    expect(r.status).toBe("COMPLETE");
    await expect(engine.getUserPositions("0xnope")).rejects.toThrow();
  });
});


