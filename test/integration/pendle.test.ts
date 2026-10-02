/**
 * Pendle adapter + generic maturity/eligibility semantics, end-to-end on the offline world.
 */
import { describe, expect, it } from "vitest";
import type { Opportunity } from "@skein/core/model/opportunity";
import { compareMetrics, comparisonGroup } from "@skein/engine/opportunities/comparison";
import { OpportunityEngine } from "@skein/engine/opportunities/engine";
import { resolveToCanonical } from "@skein/core/model/assetRelationship";
import { getPortfolio } from "@skein/portfolio/engine";
import { MorphoAdapter } from "@skein/protocols/morpho/adapter";
import { PendleAdapter } from "@skein/protocols/pendle/adapter";
import { FakeMorphoApi, fixtureMarkets, installMorpho } from "@skein/testkit/morpho";
import { FakePendleApi, fixturePendleMarkets, IMPLIED_NVDA, IMPLIED_USDG, installPendle, type FixtureMarket } from "@skein/testkit/pendle";
import { BLOCK, defaultWorld, NOW, NOW_S, NVDA, NVDA_MULT, ONE, testStack, UNKNOWN_FAKE_USDG, USDG, WALLET } from "@skein/testkit/world";

const ALL = { eligibility: "ALL" as const };

async function setup(
  opts: {
    markets?: Record<string, FixtureMarket>;
    balances?: Parameters<typeof installPendle>[2];
    withMorpho?: boolean;
    mutateWorld?: (w: ReturnType<typeof defaultWorld>) => void;
    clock?: { t: number };
  } = {},
) {
  const markets = opts.markets ?? fixturePendleMarkets();
  const world = defaultWorld();
  installPendle(world, markets, opts.balances);
  const morphoMarkets = fixtureMarkets();
  if (opts.withMorpho) installMorpho(world, morphoMarkets);
  opts.mutateWorld?.(world);
  const s = await testStack({ world });
  const api = new FakePendleApi(markets);
  const clock = opts.clock ?? { t: NOW.getTime() };
  const pendle = new PendleAdapter(s.http, { api, now: () => clock.t });
  const adapters = opts.withMorpho ? [new MorphoAdapter(s.http, { api: new FakeMorphoApi(Object.values(morphoMarkets).map((m) => m.apiRaw)), now: () => clock.t }), pendle] : [pendle];
  const engine = new OpportunityEngine(adapters, { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
  return { s, api, pendle, engine, world, markets, clock };
}

const get = (list: Opportunity[], category: string, m: FixtureMarket) => list.find((o) => o.category === category && o.venue.id === m.market.toLowerCase())!;
const pendleDetails = (o: Opportunity) => {
  if (o.details.kind !== "PENDLE_MARKET") throw new Error("not pendle");
  return o.details;
};

describe("Pendle discovery and identity", () => {
  it("discovers every market from factory logs (none hardcoded) and publishes PT, YT and LP per market", async () => {
    const { engine, markets } = await setup();
    const r = await engine.getOpportunities(ALL);
    const venues = new Set(r.data.map((o) => o.venue.id));
    // The broken market is still discovered (identity recorded as unverified), the rest normally.
    for (const m of Object.values(markets)) expect(venues.has(m.market.toLowerCase())).toBe(true);
    const nvda = r.data.filter((o) => o.venue.id === markets.nvda!.market.toLowerCase()).map((o) => o.category).sort();
    expect(nvda).toEqual(["FIXED_YIELD", "LP", "YIELD"]);
    expect(r.status).toBe("COMPLETE");
  });

  it("identity comes from chain: PT/YT/SY, expiry, factory checks, cross-links", async () => {
    const { engine, markets } = await setup();
    const pt = get((await engine.getOpportunities()).data, "FIXED_YIELD", markets.nvda!);
    const d = pendleDetails(pt);
    expect([d.pt.address, d.yt.address, d.sy.address]).toEqual([markets.nvda!.pt, markets.nvda!.yt, markets.nvda!.sy]);
    expect(d.identityChecks.every((c) => c.ok === true)).toBe(true);
    expect(d.identityChecks.map((c) => c.check)).toEqual(expect.arrayContaining(["factory.isValidMarket(market)", "yieldContractFactory.isPT(PT)", "PT.SY() == market SY", "YT.PT() == market PT"]));
    expect(pt.lifecycle.maturity?.source.type).toBe("ONCHAIN");
    expect(pt.lifecycle.maturity?.value).toBe(new Date(Number(markets.nvda!.expiry) * 1000).toISOString());
    expect(d.pt.canonical).toBe(false); // protocol-issued: never canonical
  });

  it("a broken PT→SY link makes the market UNVERIFIED and excluded by default", async () => {
    const { engine, markets } = await setup();
    const all = await engine.getOpportunities(ALL);
    const b = get(all.data, "FIXED_YIELD", markets.broken!);
    expect(b.verificationStatus).toBe("UNVERIFIED");
    expect(b.eligibility!.excludedBy).toContain("INSUFFICIENT_VERIFICATION");
    expect(b.entry.steps[1]!.verified).toBe(false);
    expect(b.warnings.map((w) => w.code)).toContain("MARKET_UNVERIFIED_ONCHAIN");
    expect((await engine.getOpportunities()).data.some((o) => o.venue.id === markets.broken!.market.toLowerCase())).toBe(false);
  });

  it("API/chain identity disagreement: both values kept, onchain used, CONFLICT, excluded by default", async () => {
    const markets = fixturePendleMarkets();
    const api = markets.nvda!.api as Record<string, unknown>;
    markets.nvda!.api = { ...api, pt: { ...(api.pt as object), address: "0x000000000000000000000000000000000000beef" } };
    const { engine } = await setup({ markets });
    const pt = get((await engine.getOpportunities(ALL)).data, "FIXED_YIELD", markets.nvda!);
    const c = pt.conflicts.find((x) => x.field === "pt")!;
    expect(c.values.map((v) => v.source.type)).toEqual(["OFFICIAL_API", "ONCHAIN"]);
    expect(pendleDetails(pt).pt.address).toBe(markets.nvda!.pt);
    expect(pt.verificationStatus).toBe("CONFLICT");
    expect(pt.eligibility!.excludedBy).toContain("DATA_CONFLICT");
  });

  it("new markets are picked up incrementally after the list TTL (scan resumes after the last scanned block)", async () => {
    const clock = { t: NOW.getTime() };
    const { engine, world, s } = await setup({ clock });
    await engine.getOpportunities(ALL);
    const q1 = s.reader.logQueries;
    await engine.getOpportunities(ALL);
    expect(s.reader.logQueries).toBe(q1); // list cached
    clock.t += 11 * 60_000;
    const extra = fixturePendleMarkets().usdg!;
    const fresh = { ...extra, market: "0x000000000000000000000000000000000000E0FF" as const, pt: "0x000000000000000000000000000000000000E1FF" as const, yt: "0x000000000000000000000000000000000000E2FF" as const, sy: "0x000000000000000000000000000000000000E3FF" as const, createdAt: BLOCK.number + 50n };
    installPendle(world, { fresh });
    const ctx = { ...(await engine.context()), blockNumber: BLOCK.number + 100n };
    const r = await engine.getOpportunities(ALL, ctx);
    expect(s.reader.logQueries).toBe(q1 + 1);
    expect(r.data.some((o) => o.venue.id === fresh.market.toLowerCase())).toBe(true);
  });
});

describe("PT = FIXED_YIELD semantics", () => {
  it("IMPLIED_APY is computed onchain as exp(lastLnImpliedRate) − 1, never labelled guaranteed", async () => {
    const { engine, markets } = await setup();
    const pt = get((await engine.getOpportunities()).data, "FIXED_YIELD", markets.nvda!);
    const y = pt.yields.find((m) => m.type === "IMPLIED_APY")!;
    expect(y.value - IMPLIED_NVDA).toBeGreaterThanOrEqual(-1n);
    expect(y.value - IMPLIED_NVDA).toBeLessThanOrEqual(1n);
    expect(y).toMatchObject({ side: "EARN", basis: "IMPLIED", origin: "COMPUTED", verification: "VERIFIED_ONCHAIN" });
    expect(y.formula).toMatch(/lastLnImpliedRate/);
    expect(y.label).toMatch(/not a guaranteed return/);
    expect(pt.yields.some((m) => m.type === "FIXED_APY")).toBe(false);
    expect(pt.warnings.map((w) => w.code)).toContain("IMPLIED_RATE_NOT_GUARANTEED");
    expect(pt.conflicts).toEqual([]); // API 0.07288762163 agrees
  });

  it("PT discount is 1 − ptToAssetRate from RouterStatic; API ROI kept separately", async () => {
    const { engine, markets } = await setup();
    const d = pendleDetails(get((await engine.getOpportunities()).data, "FIXED_YIELD", markets.nvda!));
    expect(d.ptDiscount?.value).toBe(ONE - markets.nvda!.ptRate);
    expect(d.ptDiscount?.origin).toBe("COMPUTED");
    expect(d.ptRoiToMaturity?.source.type).toBe("OFFICIAL_API");
  });

  it("API implied rate far from chain → DATA_CONFLICT recorded, onchain kept, opportunity still eligible", async () => {
    const markets = fixturePendleMarkets();
    markets.usdg!.api = { ...(markets.usdg!.api as object), impliedApy: 0.05 };
    const { engine } = await setup({ markets });
    const pt = get((await engine.getOpportunities(ALL)).data, "FIXED_YIELD", markets.usdg!);
    expect(pt.conflicts.find((c) => c.field === "impliedApy")?.resolution).toMatch(/onchain value used/);
    expect(pt.yields.find((y) => y.type === "IMPLIED_APY")!.value).toBe(IMPLIED_USDG);
    expect(pt.verificationStatus).not.toBe("CONFLICT");
  });

  it("accounting unit: Stock Token SY rate == uiMultiplier → share units, not tokens; USDG → token units", async () => {
    const { engine, markets } = await setup();
    const list = (await engine.getOpportunities()).data;
    const nv = get(list, "FIXED_YIELD", markets.nvda!);
    expect(pendleDetails(nv).accountingUnit).toMatchObject({ assetType: "LIQUIDITY", syRateEqualsMultiplier: true });
    expect(pendleDetails(nv).syExchangeRate?.value).toBe(NVDA_MULT);
    expect(nv.yields.find((y) => y.type === "IMPLIED_APY")!.denominatedIn).toBeNull();
    expect(nv.warnings.map((w) => w.code)).toContain("ACCOUNTING_UNIT_NOT_TOKEN");
    const us = get(list, "FIXED_YIELD", markets.usdg!);
    expect(pendleDetails(us).accountingUnit.assetType).toBe("TOKEN");
    expect(us.yields.find((y) => y.type === "IMPLIED_APY")!.denominatedIn?.address).toBe(USDG);
  });
});

describe("YT and LP semantics", () => {
  it("YT: YIELD_EXPOSURE_APY from the API, decays-to-zero warning, never IMPLIED_APY", async () => {
    const { engine, markets } = await setup();
    const yt = get((await engine.getOpportunities()).data, "YIELD", markets.usdg!);
    expect(yt.yields.map((y) => y.type).sort()).toEqual(["UNDERLYING_APY", "YIELD_EXPOSURE_APY"]);
    expect(yt.yields.find((y) => y.type === "YIELD_EXPOSURE_APY")!.value).toBeLessThan(0n);
    expect(yt.warnings.map((w) => w.code)).toContain("YIELD_TOKEN_DECAYS_TO_ZERO");
    expect(pendleDetails(yt).position).toBe("YT");
  });

  it("stock-token YT: API underlyingApy 0 while SY rate is the multiplier → UNDERLYING_YIELD_SOURCE_UNCLEAR", async () => {
    const { engine, markets } = await setup();
    const yt = get((await engine.getOpportunities(ALL)).data, "YIELD", markets.nvda!);
    expect(yt.warnings.find((w) => w.code === "UNDERLYING_YIELD_SOURCE_UNCLEAR")?.message).toMatch(/uiMultiplier/);
  });

  it("USDG underlying yield from an external reward is UNDERLYING_UNVERIFIED", async () => {
    const { engine, markets } = await setup();
    const pt = get((await engine.getOpportunities()).data, "FIXED_YIELD", markets.usdg!);
    expect(pt.warnings.find((w) => w.code === "UNDERLYING_UNVERIFIED")?.message).toMatch(/EXTERNAL_REWARD 3\.30%/);
  });

  it("LP: NET_APY headline, typed components pointing at it, PENDLE reward with its token, LP_SHARE_OF relationships", async () => {
    const { engine, markets } = await setup();
    const lp = get((await engine.getOpportunities()).data, "LP", markets.nvda!);
    const comps = lp.yields.filter((y) => y.type === "COMPONENT_APY");
    expect(comps.map((c) => [c.component, c.componentOf])).toEqual([["swapFee", "NET_APY"], ["lpReward", "NET_APY"]]);
    const reward = lp.yields.find((y) => y.type === "REWARD_APY")!;
    expect(reward.rewardAsset?.symbol).toBe("PENDLE");
    expect(lp.risk.rewardDependence.known).toBe(true);
    expect(lp.relationships.filter((r) => r.kind === "LP_SHARE_OF").map((r) => r.to.address)).toEqual([markets.nvda!.pt, markets.nvda!.sy]);
  });

  it("comparison groups: IMPLIED vs SUPPLY are not displayed or ranked together; YT is speculation", async () => {
    const { engine, markets } = await setup();
    const list = (await engine.getOpportunities()).data;
    const implied = get(list, "FIXED_YIELD", markets.usdg!).yields.find((y) => y.type === "IMPLIED_APY")!;
    const ytm = get(list, "YIELD", markets.usdg!).yields.find((y) => y.type === "YIELD_EXPOSURE_APY")!;
    const lpNet = get(list, "LP", markets.usdg!).yields.find((y) => y.type === "NET_APY")!;
    expect(comparisonGroup(implied)).toBe("CAPITAL_YIELD_TO_MATURITY");
    expect(comparisonGroup(ytm)).toBe("YIELD_SPECULATION");
    expect(comparisonGroup(lpNet, "LP")).toBe("LP_RETURN");
    const supply = { ...implied, type: "SUPPLY_APY" as const, basis: "VARIABLE" as const };
    const c = compareMetrics({ metric: implied, category: "FIXED_YIELD" }, { metric: supply, category: "LEND" });
    expect(c).toMatchObject({ displayTogether: false, rankable: false });
  });
});

describe("relationships, entry and liquidity", () => {
  it("PT resolves to the canonical underlying through SY; relationships carry onchain provenance", async () => {
    const { engine, markets } = await setup();
    const pt = get((await engine.getOpportunities()).data, "FIXED_YIELD", markets.nvda!);
    const r = resolveToCanonical(pendleDetails(pt).pt, pt.relationships);
    expect(r.canonical?.address).toBe(NVDA);
    expect(r.path.map((e) => e.kind)).toEqual(["PRINCIPAL_COMPONENT_OF", "WRAPS"]);
    expect(pt.relationships.every((e) => e.source.type === "ONCHAIN" && e.verification === "VERIFIED_ONCHAIN")).toBe(true);
    expect(pt.relationships.find((e) => e.kind === "REPRESENTS_CLAIM_ON")?.terms).toMatch(/watermark/);
  });

  it("entry: SY conversion required, WRAP verified by getTokensIn, then SWAP; router single call cited, nothing built", async () => {
    const { engine, markets } = await setup();
    const pt = get((await engine.getOpportunities()).data, "FIXED_YIELD", markets.nvda!);
    expect(pt.entry.kind).toBe("SY_CONVERSION_REQUIRED");
    expect(pt.entry.requiredAsset.address).toBe(NVDA);
    expect(pt.primaryAsset.canonical).toBe(true);
    expect(pt.entry.steps.map((s) => [s.action, s.verified])).toEqual([["WRAP", true], ["SWAP", true]]);
    expect(pt.entry.singleTransactionAvailable).toMatchObject({ known: true, value: true });
    const json = JSON.stringify(pt.entry, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(json).not.toMatch(/0x[0-9a-f]{72,}/i); // no encoded call payloads
    expect(json).not.toMatch(/"(data|calldata|input|value|to)":\s*"0x/i);
  });

  it("an SY with no readable input token → entry UNKNOWN, ENTRY_ROUTE_UNKNOWN, excluded by default", async () => {
    const markets = fixturePendleMarkets();
    markets.usdg!.tokensIn = [];
    const { engine } = await setup({ markets });
    const pt = get((await engine.getOpportunities(ALL)).data, "FIXED_YIELD", markets.usdg!);
    expect(pt.entry.kind).toBe("UNKNOWN");
    expect(pt.eligibility!.excludedBy).toContain("ENTRY_ROUTE_UNKNOWN");
    expect(pt.warnings.filter((w) => w.code === "ENTRY_ROUTE_UNKNOWN")).toHaveLength(1);
  });

  it("pool liquidity is computed onchain in yield-token units, priced by the Price Service; API figure kept", async () => {
    const { engine, markets } = await setup();
    const m = markets.nvda!;
    const pt = get((await engine.getOpportunities()).data, "FIXED_YIELD", m);
    const expected = m.totalSy + (m.totalPt * m.ptRate) / m.syRate;
    expect(pt.availableLiquidity?.value.amount?.raw).toBe(expected);
    expect(pt.liquidityKind).toBe("POOL_LIQUIDITY");
    expect(pt.availableLiquidity?.value.usd).not.toBeNull();
    expect(pt.availableLiquidity?.formula).toMatch(/previewRedeem/);
    expect(pendleDetails(pt).apiLiquidityUsd?.source.type).toBe("OFFICIAL_API");
  });

  it("an unpriced/non-canonical yield token has no USD liquidity and never borrows a price", async () => {
    const { engine, markets } = await setup();
    const pt = get((await engine.getOpportunities(ALL)).data, "FIXED_YIELD", markets.lookalike!);
    expect(pt.availableLiquidity?.value.usd).toBeNull();
    expect(pt.warnings.map((w) => w.code)).toContain("LOOKALIKE_TOKEN");
    expect(pt.eligibility!.excludedBy).toContain("UNVERIFIED_ASSET");
  });
});

describe("lifecycle", () => {
  it("expired market: EXPIRED at the block timestamp, cannot enter, no yields, hidden unless requested", async () => {
    const { engine, markets } = await setup();
    const all = await engine.getOpportunities(ALL);
    const pt = get(all.data, "FIXED_YIELD", markets.expired!);
    expect(pt.lifecycle).toMatchObject({ state: "EXPIRED", canEnter: false, blockers: ["EXPIRED"] });
    expect(pt.lifecycle.secondsToMaturity).toBe(-86_400);
    expect(pt.lifecycle.timeReference?.kind).toBe("BLOCK_TIMESTAMP");
    expect(pt.yields).toEqual([]);
    expect(pt.warnings.map((w) => w.code)).toContain("EXPIRED_MARKET");
    expect((await engine.getOpportunities()).data.some((o) => o.id === pt.id)).toBe(false);
    const inc = await engine.getOpportunities({ includeReasons: ["EXPIRED"] });
    expect(inc.data.some((o) => o.id === pt.id)).toBe(true);
  });

  it("paused SY blocks entry (PROTOCOL_PAUSED) even before maturity", async () => {
    const markets = fixturePendleMarkets();
    markets.usdg!.paused = true;
    const { engine } = await setup({ markets });
    const pt = get((await engine.getOpportunities(ALL)).data, "FIXED_YIELD", markets.usdg!);
    expect(pt.lifecycle.blockers).toContain("PROTOCOL_PAUSED");
    expect(pt.eligibility!.excludedBy).toContain("PROTOCOL_PAUSED");
  });

  it("filters: maturity range drops open-ended opportunities; MATURITY sort lists open-ended as not comparable", async () => {
    const { engine, markets } = await setup({ withMorpho: true });
    const r = await engine.getOpportunities({ filter: { maturityFromS: BigInt(NOW_S), maturityToS: BigInt(NOW_S + 60 * 86_400) } });
    expect(r.data.length).toBeGreaterThan(0);
    expect(r.data.every((o) => o.venue.id === markets.nvda!.market.toLowerCase())).toBe(true);
    const s = await engine.getOpportunities({ sort: { by: "MATURITY" } });
    const firstMorpho = s.data.findIndex((o) => o.protocol.id === "morpho");
    expect(s.data.slice(0, firstMorpho).every((o) => o.protocol.id === "pendle")).toBe(true);
    expect(s.data[0]!.venue.id).toBe(markets.nvda!.market.toLowerCase()); // soonest first
    expect(s.notComparable!.length).toBe(s.data.filter((o) => o.protocol.id === "morpho").length);
  });

  it("filters: protocol, category, lifecycle state, min liquidity (missing USD is excluded, not zero)", async () => {
    const { engine } = await setup({ withMorpho: true });
    const r = await engine.getOpportunities({ ...ALL, filter: { protocols: ["pendle"], categories: ["FIXED_YIELD"], lifecycleStates: ["ACTIVE"], minLiquidityUsdE18: 1n } });
    expect(r.data.every((o) => o.protocol.id === "pendle" && o.category === "FIXED_YIELD" && o.lifecycle.state === "ACTIVE" && o.availableLiquidity?.value.usd)).toBe(true);
    expect(r.data.length).toBeGreaterThan(0);
  });

  it("IMPLIED_APY sort ranks only opportunities that have it", async () => {
    const { engine } = await setup({ withMorpho: true });
    const r = await engine.getOpportunities({ sort: { by: "YIELD", yieldType: "IMPLIED_APY", direction: "DESC" } });
    const ranked = r.data.slice(0, r.data.length - r.notComparable!.length);
    expect(ranked.every((o) => o.category === "FIXED_YIELD")).toBe(true);
  });
});

describe("listing, API failure and caching", () => {
  it("a market the API does not index (404) is discovered onchain, listed=false, advisory only, status COMPLETE", async () => {
    const { engine, markets } = await setup();
    const r = await engine.getOpportunities(ALL);
    const pt = get(r.data, "FIXED_YIELD", markets.dust!);
    expect(pt.risk.protocolListed).toMatchObject({ known: true, value: false });
    expect(pt.eligibility!.advisories).toEqual(expect.arrayContaining(["PROTOCOL_UNLISTED", "LOW_LIQUIDITY"]));
    expect(pt.eligibility!.excludedBy).toEqual(["DUST_LIQUIDITY"]); // Phase 4 P3-2: ~$1 pool
    expect(pt.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["UNLISTED_MARKET", "LOW_LIQUIDITY"]));
    expect(pt.yields.map((y) => y.type)).toEqual(["IMPLIED_APY"]); // onchain only
    expect(r.adapters[0]!.status).toBe("COMPLETE");
  });

  it("expired markets are not requested from the API; the wallet is never sent to the API", async () => {
    const { engine, api, markets } = await setup({ balances: { nvda: { pt: ONE } } });
    await engine.getOpportunities(ALL);
    await engine.getUserPositions(WALLET);
    expect(api.calls).not.toContain(markets.expired!.market.toLowerCase());
    expect(api.calls.join()).not.toContain(WALLET.toLowerCase().slice(2));
  });

  it("API down with no cache: onchain PT still published (implied rate from chain), PARTIAL, STALE_PROTOCOL_DATA", async () => {
    const { engine, api, markets } = await setup();
    api.down = true;
    const r = await engine.getOpportunities(ALL);
    expect(r.status).toBe("PARTIAL");
    const pt = get(r.data, "FIXED_YIELD", markets.nvda!);
    expect(pt.yields.map((y) => y.type)).toEqual(["IMPLIED_APY"]);
    expect(pt.warnings.map((w) => w.code)).toContain("STALE_PROTOCOL_DATA");
    expect(pt.risk.protocolListed.known).toBe(false);
  });

  it("API outage after a good fetch: last good state served within the bound, marked stale; failures not cached", async () => {
    const clock = { t: NOW.getTime() };
    const { engine, api, markets } = await setup({ clock });
    await engine.getOpportunities();
    clock.t += 2 * 60_000;
    api.down = true;
    const r = await engine.getOpportunities();
    const lp = get(r.data, "LP", markets.nvda!);
    expect(lp.yields.some((y) => y.type === "NET_APY")).toBe(true);
    expect(lp.warnings.find((w) => w.code === "STALE_PROTOCOL_DATA")?.message).toMatch(/cache/);
    expect(r.status).toBe("PARTIAL");
    api.down = false;
    const n = api.calls.length;
    await engine.getOpportunities();
    expect(api.calls.length).toBeGreaterThan(n); // refetched, the failure was not cached
  });

  it("identity is read once (config cache); pool state every run; API state after its TTL", async () => {
    const clock = { t: NOW.getTime() };
    const { engine, api, world } = await setup({ clock });
    await engine.getOpportunities();
    const c = world.callCounts!;
    const [rt, st, calls] = [c.get("readTokens")!, c.get("_storage")!, api.calls.length];
    await engine.getOpportunities();
    expect(c.get("readTokens")).toBe(rt);
    expect(c.get("_storage")!).toBeGreaterThan(st);
    expect(api.calls.length).toBe(calls);
    clock.t += 61_000;
    await engine.getOpportunities();
    expect(api.calls.length).toBeGreaterThan(calls);
  });

  it("discovery failure with no list: Pendle UNKNOWN, Morpho COMPLETE → overall PARTIAL (isolation)", async () => {
    const { engine } = await setup({ withMorpho: true, mutateWorld: (w) => (w.logsFail = true) });
    const r = await engine.getOpportunities();
    expect(r.adapters.find((a) => a.protocol === "pendle")!.status).toBe("UNKNOWN");
    expect(r.adapters.find((a) => a.protocol === "morpho")!.status).toBe("COMPLETE");
    expect(r.status).toBe("PARTIAL");
    expect(r.warnings.map((w) => w.code)).toContain("ADAPTER_FAILED");
    expect(r.data.some((o) => o.protocol.id === "morpho")).toBe(true);
  });

  it("discovery failure with a known list: stale list served (bounded), MARKET_DISCOVERY_DEGRADED", async () => {
    const clock = { t: NOW.getTime() };
    const { engine, world } = await setup({ clock });
    await engine.getOpportunities();
    clock.t += 11 * 60_000;
    world.logsFail = true;
    const r = await engine.getOpportunities({}, { ...(await engine.context()), blockNumber: BLOCK.number + 100n });
    expect(r.status).toBe("PARTIAL");
    expect(r.warnings.map((w) => w.code)).toContain("MARKET_DISCOVERY_DEGRADED");
    expect(r.data.length).toBeGreaterThan(0);
  });
});

describe("sanitization and read-only", () => {
  it("token symbols from chain are sanitized; names never reach output raw", async () => {
    const markets = fixturePendleMarkets();
    markets.usdg!.ptSymbol = "PT-<script>alert(1)</script>\u0000‮";
    const { engine } = await setup({ markets });
    const pt = get((await engine.getOpportunities(ALL)).data, "FIXED_YIELD", markets.usdg!);
    const sym = pendleDetails(pt).pt.symbol;
    expect(sym).not.toMatch(/[<>\u0000‮]/);
    expect(pt.title).not.toMatch(/[<>]/);
  });

  it("capabilities: discovery, positions and single lookup implemented; execution false; no signing surface", async () => {
    const { pendle } = await setup();
    expect(pendle.capabilities).toEqual({ discovery: true, assetFiltering: false, userPositions: true, singleOpportunity: true, execution: false });
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(pendle)).join(",");
    expect(methods).not.toMatch(/sign|send|approve|permit|execute|calldata|buildTx/i);
  });
});

describe("positions and portfolio composition", () => {
  it("PT/YT/LP balances valued via RouterStatic → SY → yield token, priced by the Price Service; rewards excluded", async () => {
    const { engine, markets } = await setup({ balances: { nvda: { pt: 2n * ONE, lp: ONE }, expired: { pt: 5_000_000n } } });
    const r = await engine.getUserPositions(WALLET);
    const pt = r.data.find((p) => p.kind === "PRINCIPAL_TOKEN" && p.venue.id === markets.nvda!.market.toLowerCase())!;
    const expected = (((2n * ONE * markets.nvda!.ptRate) / ONE) * ONE) / NVDA_MULT;
    expect(pt.supplied?.value.amount?.raw).toBe(expected);
    expect(pt.supplied?.value.usd).not.toBeNull();
    expect(pt.shares?.value).toBe(2n * ONE);
    expect(pt.warnings.map((w) => w.code)).toContain("REWARDS_MAY_BE_INCOMPLETE");
    expect(r.data.find((p) => p.kind === "LIQUIDITY_POOL")).toBeDefined();
    const matured = r.data.find((p) => p.venue.id === markets.expired!.market.toLowerCase())!;
    expect(matured.maturity).toMatchObject({ expired: true });
    expect(matured.supplied?.value.amount?.raw).toBe(5_000_000n); // 1 PT = 1 USDG after maturity
    expect(r.data.some((p) => p.kind === "YIELD_TOKEN")).toBe(false); // zero balances omitted
  });

  it("NVDA holder: Morpho COLLATERAL plus Pendle PT/YT/LP with ENTER_POSITION context in NVDA", async () => {
    const { s, engine } = await setup({ withMorpho: true });
    const portfolio = await getPortfolio(WALLET, s.deps);
    const res = await engine.getPortfolioOpportunities(portfolio);
    const nv = res.data.find((g) => g.assetKey === `4663:${NVDA.toLowerCase()}`)!;
    const cats = new Set(nv.items.map((p) => `${p.opportunity.protocol.id}:${p.opportunity.category}`));
    // Phase 4 (P3-1): the Stock Token YT is UNRESOLVED_YIELD_SEMANTICS → not in the default view…
    expect(cats).toEqual(new Set(["morpho:COLLATERAL", "pendle:FIXED_YIELD", "pendle:LP"]));
    // …but still discoverable, with its context, in the full view.
    const full = await engine.getPortfolioOpportunities(portfolio, { eligibility: "ALL" });
    const nvFull = full.data.find((g) => g.assetKey === `4663:${NVDA.toLowerCase()}`)!;
    expect(nvFull.items.some((p) => p.opportunity.protocol.id === "pendle" && p.opportunity.category === "YIELD" && p.context.kind === "ENTER_POSITION")).toBe(true);
    const fixed = nv.items.find((p) => p.opportunity.category === "FIXED_YIELD")!;
    expect(fixed.context).toMatchObject({ kind: "ENTER_POSITION", enterWith: { amount: { raw: 2n * ONE } }, referenceYield: { type: "IMPLIED_APY" } });
    expect(fixed.context.kind === "ENTER_POSITION" && fixed.context.caveat).toMatch(/fees and slippage/);
  });

  it("USDG holder: Morpho LEND and Pendle USDG markets side by side; look-alike 'USDG' market never offered", async () => {
    const { s, engine, markets } = await setup({ withMorpho: true });
    const portfolio = await getPortfolio(WALLET, s.deps);
    const res = await engine.getPortfolioOpportunities(portfolio);
    const us = res.data.find((g) => g.assetKey === `4663:${USDG.toLowerCase()}`)!;
    const protos = new Set(us.items.map((p) => p.opportunity.protocol.id));
    expect(protos).toEqual(new Set(["morpho", "pendle"]));
    expect(us.items.some((p) => p.opportunity.venue.id === markets.lookalike!.market.toLowerCase())).toBe(false);
    expect(res.data.some((g) => g.assetKey === `4663:${UNKNOWN_FAKE_USDG.toLowerCase()}`)).toBe(false);
  });
});
