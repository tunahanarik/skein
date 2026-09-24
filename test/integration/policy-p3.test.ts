/**
 * Regression tests for the three Phase 3 policy decisions applied in Phase 4.
 *   P3-1  Stock Token YT with unresolved yield semantics: discoverable, hidden by default, APY untouched
 *   P3-2  DUST_LIQUIDITY excludes; LOW_LIQUIDITY stays advisory
 *   P3-3  PROTOCOL_UNLISTED is advisory; a verified, liquid, live unlisted market stays visible
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_ELIGIBILITY_POLICY } from "../../src/config/eligibility.js";
import type { Opportunity } from "../../src/model/opportunity.js";
import { computeEligibility } from "../../src/opportunities/eligibility.js";
import { OpportunityEngine } from "../../src/opportunities/engine.js";
import { PendleAdapter } from "../../src/protocols/pendle/adapter.js";
import { FakePendleApi, fixturePendleMarkets, installPendle } from "../fixtures/pendle.js";
import { defaultWorld, NOW, testStack } from "../fixtures/world.js";

async function setup() {
  const markets = fixturePendleMarkets();
  const world = defaultWorld();
  installPendle(world, markets);
  const s = await testStack({ world });
  const engine = new OpportunityEngine([new PendleAdapter(s.http, { api: new FakePendleApi(markets), now: () => NOW.getTime() })], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
  return { engine, markets };
}
const at = (list: Opportunity[], cat: string, market: string) => list.find((o) => o.category === cat && o.venue.id === market.toLowerCase());

describe("P3-1 Stock Token YT with unresolved yield semantics", () => {
  it("is discoverable but hidden from the default view with UNRESOLVED_YIELD_SEMANTICS", async () => {
    const { engine, markets } = await setup();
    const all = await engine.getOpportunities({ eligibility: "ALL" });
    const yt = at(all.data, "YIELD", markets.nvda!.market)!;
    expect(yt.eligibility!.excludedBy).toEqual(["UNRESOLVED_YIELD_SEMANTICS"]);
    const def = await engine.getOpportunities();
    expect(at(def.data, "YIELD", markets.nvda!.market)).toBeUndefined();
    expect(def.excluded!.byReason.UNRESOLVED_YIELD_SEMANTICS).toBe(1);
  });

  it("the reported APY is not rewritten: −100% stays as supplied, flagged UNRESOLVED with a reason", async () => {
    const { engine, markets } = await setup();
    const yt = at((await engine.getOpportunities({ eligibility: "ALL" })).data, "YIELD", markets.nvda!.market)!;
    const m = yt.yields.find((y) => y.type === "YIELD_EXPOSURE_APY")!;
    expect(m.value).toBe(-(10n ** 18n));
    expect(m.origin).toBe("SUPPLIED");
    expect(m.semantics).toMatchObject({ status: "UNRESOLVED" });
    expect(m.semantics!.reason).toMatch(/uiMultiplier/);
  });

  it("only the Stock Token YT: the same market's PT/LP and the USDG YT stay visible", async () => {
    const { engine, markets } = await setup();
    const def = (await engine.getOpportunities()).data;
    expect(at(def, "FIXED_YIELD", markets.nvda!.market)).toBeDefined();
    expect(at(def, "LP", markets.nvda!.market)).toBeDefined();
    expect(at(def, "YIELD", markets.usdg!.market)).toBeDefined();
  });

  it("is re-admitted explicitly with includeReasons", async () => {
    const { engine, markets } = await setup();
    const r = await engine.getOpportunities({ includeReasons: ["UNRESOLVED_YIELD_SEMANTICS"] });
    expect(at(r.data, "YIELD", markets.nvda!.market)).toBeDefined();
  });
});

describe("P3-2 dust vs low liquidity", () => {
  it("the ~$1 market is DUST_LIQUIDITY (excluded); the ~$49.8k market is not dust (LOW_LIQUIDITY is not even triggered above $10k)", async () => {
    const { engine, markets } = await setup();
    const all = (await engine.getOpportunities({ eligibility: "ALL" })).data;
    const dust = at(all, "FIXED_YIELD", markets.dust!.market)!;
    expect(dust.eligibility!.excludedBy).toContain("DUST_LIQUIDITY");
    expect(dust.eligibility!.advisories).toContain("LOW_LIQUIDITY");
    const usdg = at(all, "FIXED_YIELD", markets.usdg!.market)!;
    expect(usdg.eligibility!.excludedBy).not.toContain("DUST_LIQUIDITY");
    expect(usdg.eligibility!.eligibleForDefaultDisplay).toBe(true);
    const def = (await engine.getOpportunities()).data;
    expect(at(def, "FIXED_YIELD", markets.dust!.market)).toBeUndefined();
    expect(at(def, "FIXED_YIELD", markets.usdg!.market)).toBeDefined();
  });

  it("threshold is centralized ($50) and boundaries are exact; low liquidity alone never excludes", () => {
    expect(DEFAULT_ELIGIBILITY_POLICY.dustLiquidityUsdE18).toBe(50n * 10n ** 18n);
    const mk = (usd: bigint | null, tvlUsd: bigint | null = null): Opportunity =>
      ({
        category: "LP",
        yields: [],
        verificationStatus: "VERIFIED_ONCHAIN",
        risk: { allAssetsCanonical: true, protocolListed: { known: false, reason: "" } },
        lifecycle: { state: "ACTIVE", canEnter: true, blockers: [] },
        entry: { kind: "DIRECT" },
        availableLiquidity: usd === null ? null : { value: { usd: { e18: usd, display: "" }, amount: { raw: 1n, decimals: 0, display: "" } } },
        tvl: tvlUsd === null ? null : { value: { usd: { e18: tvlUsd, display: "" }, amount: null } },
      }) as unknown as Opportunity;
    const E = 10n ** 18n;
    expect(computeEligibility(mk(49n * E)).excludedBy).toEqual(["DUST_LIQUIDITY"]);
    expect(computeEligibility(mk(50n * E)).excludedBy).toEqual([]); // exactly $50 is not dust
    expect(computeEligibility(mk(5_000n * E))).toMatchObject({ eligibleForDefaultDisplay: true, advisories: ["LOW_LIQUIDITY"] });
    expect(computeEligibility(mk(10n * E, 1_000n * E)).excludedBy).toEqual([]); // venue size = max(TVL, liquidity)
    expect(computeEligibility(mk(null)).excludedBy).toEqual([]); // unknown USD is never dust
  });
});

describe("P3-3 unlisted but verified, liquid, live market", () => {
  it("stays in the default view with PROTOCOL_UNLISTED as an advisory only", async () => {
    const { engine, markets } = await setup();
    const def = (await engine.getOpportunities()).data;
    for (const cat of ["FIXED_YIELD", "LP"]) {
      const o = at(def, cat, markets.usdg!.market)!;
      expect(o).toBeDefined();
      expect(o.risk.protocolListed).toMatchObject({ known: true, value: false });
      expect(o.eligibility!.advisories).toContain("PROTOCOL_UNLISTED");
      expect(o.eligibility!.excludedBy).toEqual([]);
      expect(o.lifecycle).toMatchObject({ state: "ACTIVE", canEnter: true });
      expect(pendleChecksOk(o)).toBe(true);
    }
    expect(DEFAULT_ELIGIBILITY_POLICY.excluding).not.toContain("PROTOCOL_UNLISTED");
  });
});

function pendleChecksOk(o: Opportunity): boolean {
  return o.details.kind === "PENDLE_MARKET" && o.details.identityChecks.every((c) => c.ok === true);
}
