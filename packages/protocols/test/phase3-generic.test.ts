/**
 * Phase 3 generic pieces: fixed-point exp, lifecycle, eligibility, comparison groups, log
 * discovery with range bisection, symbol sanitization.
 */
import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { ViemChainReader, isLogRangeError } from "@skein/chain/reader";
import { DEFAULT_ELIGIBILITY_POLICY } from "@skein/core/config/eligibility";
import { sanitizeSymbol } from "@skein/core/lib/sanitize";
import type { Opportunity, YieldMetric } from "@skein/core/model/opportunity";
import type { DataSource } from "@skein/core/model/provenance";
import { compareMetrics, comparisonGroup } from "@skein/engine/opportunities/comparison";
import { computeEligibility, passesEligibility } from "@skein/engine/opportunities/eligibility";
import { maturityLifecycle, openEndedLifecycle } from "@skein/engine/opportunities/lifecycle";
import { createNewMarketEvent } from "../src/pendle/constants.js";
import { differsByMoreThanPct, expm1Wad, impliedApyFromLnRate } from "../src/pendle/math.js";

const src: DataSource = { type: "ONCHAIN", provider: "t", observedAt: "2026-09-24T00:00:00Z" };
const block = { number: 100n, timestamp: 1_790_000_000n };

describe("expm1Wad (bigint)", () => {
  // Reference values: Python Decimal, 80 digits, floored to wei.
  const cases: [bigint, bigint][] = [
    [0n, 0n],
    [1n, 1n],
    [10n ** 18n, 1_718_281_828_459_045_235n],
    [3n * 10n ** 18n, 19_085_536_923_187_667_740n],
    [70_353_725_295_053_354n, 72_887_621_631_951_199n],
    [34_401_426_717_332_396n, 34_999_999_999_999_999n],
    [405_465_108_108_164_381n, 499_999_999_999_999_998n],
  ];
  it.each(cases)("expm1(%s) within 2 wei of the reference", (x, ref) => {
    const v = expm1Wad(x);
    expect(v - ref).toBeGreaterThanOrEqual(-2n);
    expect(v - ref).toBeLessThanOrEqual(2n);
  });
  it("large input keeps relative precision; out-of-range inputs throw", () => {
    const ref = 485_165_194_409_790_277_969_106_830n;
    const v = expm1Wad(20n * 10n ** 18n);
    expect(((v > ref ? v - ref : ref - v) * 10n ** 12n) / ref).toBe(0n);
    expect(() => expm1Wad(-1n)).toThrow(RangeError);
    expect(() => expm1Wad(21n * 10n ** 18n)).toThrow(RangeError);
  });
  it("implied APY is monotonic in the log rate", () => {
    expect(impliedApyFromLnRate(2n * 10n ** 16n)).toBeGreaterThan(impliedApyFromLnRate(10n ** 16n));
  });
  it("differsByMoreThanPct is relative and zero-safe", () => {
    expect(differsByMoreThanPct(100n, 101n, 1)).toBe(false);
    expect(differsByMoreThanPct(100n, 102n, 1)).toBe(true);
    expect(differsByMoreThanPct(0n, 0n, 1)).toBe(false);
  });
});

describe("lifecycle", () => {
  it("maturity exactly at the block timestamp is EXPIRED (active strictly before)", () => {
    expect(maturityLifecycle(block.timestamp, src, block, 0).state).toBe("EXPIRED");
    const a = maturityLifecycle(block.timestamp + 1n, src, block, 0);
    expect(a).toMatchObject({ state: "ACTIVE", canEnter: true, secondsToMaturity: 1 });
  });
  it("unknown expiry is UNKNOWN, never assumed active", () => {
    expect(maturityLifecycle(null, src, block, 0)).toMatchObject({ state: "UNKNOWN", canEnter: null });
  });
  it("blockers make an open-ended venue non-enterable; MARKET_INACTIVE → INACTIVE", () => {
    expect(openEndedLifecycle(block, ["DEPOSIT_DISABLED"])).toMatchObject({ state: "ACTIVE", canEnter: false });
    expect(openEndedLifecycle(block, ["MARKET_INACTIVE"]).state).toBe("INACTIVE");
  });
});

function opp(over: Partial<Opportunity> = {}): Opportunity {
  const ref = { key: "4663:0x1", chainId: 4663, address: "0x0000000000000000000000000000000000000001" as const, symbol: "X", decimals: 18, canonical: true, registryType: "STABLECOIN" };
  return {
    id: "x",
    chainId: 4663,
    protocol: { id: "t", name: "T" },
    category: "LEND",
    title: "",
    venue: { kind: "v", id: "1", address: null },
    primaryAsset: ref,
    inputAssets: [],
    outputAssets: [],
    collateralAssets: [],
    borrowAssets: [],
    yields: [],
    tvl: null,
    availableLiquidity: null,
    liquidityKind: null,
    utilization: null,
    liquidation: null,
    term: null,
    lifecycle: openEndedLifecycle(block),
    entry: { kind: "DIRECT", requiredAsset: ref, steps: [], singleTransactionAvailable: { known: false, reason: "" }, note: null },
    relationships: [],
    eligibility: null,
    contracts: [],
    risk: {
      oracle: null,
      lltv: { known: false, reason: "" },
      utilization: { known: false, reason: "" },
      availableLiquidityUsd: { known: false, reason: "" },
      marketSizeUsd: { known: false, reason: "" },
      rewardDependence: { known: false, reason: "" },
      parameterMutability: { known: false, reason: "" },
      protocolListed: { known: false, reason: "" },
      protocolWarnings: [],
      allAssetsCanonical: true,
    },
    details: { kind: "MORPHO_VAULT_V2", vault: ref.address, name: "", curator: null, totalAssets: null, performanceFee: null, managementFee: null },
    provenance: [],
    conflicts: [],
    warnings: [],
    freshness: { status: "FRESH", ageSeconds: 0, rule: "ONCHAIN_STATE" },
    verificationStatus: "VERIFIED_ONCHAIN",
    observedAt: "",
    generatedAt: "",
    ...over,
  } as Opportunity;
}

describe("eligibility (generic, from canonical fields only)", () => {
  it("a clean opportunity is eligible with no reasons", () => {
    expect(computeEligibility(opp())).toEqual({ eligibleForDefaultDisplay: true, excludedBy: [], advisories: [], policy: DEFAULT_ELIGIBILITY_POLICY.id });
  });
  it("maps facts to reasons: conflict, non-canonical, expired, deposit disabled, paused, unknown entry", () => {
    const e = computeEligibility(
      opp({
        verificationStatus: "CONFLICT",
        risk: { ...opp().risk, allAssetsCanonical: false },
        lifecycle: { ...maturityLifecycle(block.timestamp - 1n, src, block, 0, ["PROTOCOL_PAUSED", "DEPOSIT_DISABLED"]) },
        entry: { ...opp().entry, kind: "UNKNOWN" },
      }),
    );
    expect(e.excludedBy.sort()).toEqual(["DATA_CONFLICT", "DEPOSIT_DISABLED", "ENTRY_ROUTE_UNKNOWN", "EXPIRED", "PROTOCOL_PAUSED", "UNVERIFIED_ASSET"].sort());
  });
  it("unlisted and low liquidity are advisories, not exclusions; zero liquidity is flagged as such", () => {
    const liq = (e18: bigint, raw: bigint) => ({ value: { asset: opp().primaryAsset, amount: { raw, decimals: 18, display: "" }, usd: { e18, display: "" } } }) as Opportunity["availableLiquidity"];
    const e = computeEligibility(opp({ availableLiquidity: liq(5_000n * 10n ** 18n, 5n), risk: { ...opp().risk, protocolListed: { known: true, value: false, source: src } } }));
    expect(e).toMatchObject({ eligibleForDefaultDisplay: true, advisories: ["PROTOCOL_UNLISTED", "LOW_LIQUIDITY"] });
    expect(computeEligibility(opp({ availableLiquidity: liq(0n, 0n) })).advisories).toEqual(["ZERO_LIQUIDITY"]);
  });
  it("unverified-but-canonical is INSUFFICIENT_VERIFICATION; third-party-only too", () => {
    expect(computeEligibility(opp({ verificationStatus: "UNVERIFIED" })).excludedBy).toEqual(["INSUFFICIENT_VERIFICATION"]);
    expect(computeEligibility(opp({ verificationStatus: "THIRD_PARTY_ONLY" })).excludedBy).toEqual(["INSUFFICIENT_VERIFICATION"]);
  });
  it("includeReasons re-admits only when every excluding reason is listed", () => {
    const e = computeEligibility(opp({ lifecycle: maturityLifecycle(block.timestamp, src, block, 0), verificationStatus: "CONFLICT" }));
    expect(passesEligibility(e, "ELIGIBLE_ONLY", ["EXPIRED"])).toBe(false);
    expect(passesEligibility(e, "ELIGIBLE_ONLY", ["EXPIRED", "DATA_CONFLICT"])).toBe(true);
    expect(passesEligibility(e, "ALL")).toBe(true);
  });
});

describe("comparison groups", () => {
  const m = (type: YieldMetric["type"], side: YieldMetric["side"] = "EARN", unit = "4663:0x1"): YieldMetric =>
    ({ type, side, basis: "VARIABLE", compounding: "COMPOUNDED", window: "", denominatedIn: { key: unit, symbol: unit }, label: "", value: 0n, origin: "SUPPLIED", source: src, observedAt: "", freshness: { status: "FRESH", ageSeconds: 0, rule: "ONCHAIN_STATE" }, verification: "VERIFIED_ONCHAIN" }) as YieldMetric;
  it("each metric type maps to exactly one group; NET_APY depends on side and category", () => {
    expect(comparisonGroup(m("SUPPLY_APY"))).toBe("CAPITAL_YIELD_VARIABLE");
    expect(comparisonGroup(m("IMPLIED_APY"))).toBe("CAPITAL_YIELD_TO_MATURITY");
    expect(comparisonGroup(m("BORROW_APY", "PAY"))).toBe("BORROW_COST");
    expect(comparisonGroup(m("NET_APY", "PAY"))).toBe("BORROW_COST");
    expect(comparisonGroup(m("NET_APY"), "LP")).toBe("LP_RETURN");
    expect(comparisonGroup(m("NET_APY"), "VAULT")).toBe("CAPITAL_YIELD_VARIABLE");
    expect(comparisonGroup(m("YIELD_EXPOSURE_APY"))).toBe("YIELD_SPECULATION");
    expect(comparisonGroup(m("REWARD_APY"))).toBe("INCENTIVE");
    expect(comparisonGroup(m("COMPONENT_APY"))).toBe("REFERENCE");
  });
  it("rankable only for same type, side and unit; different units are called out", () => {
    expect(compareMetrics({ metric: m("SUPPLY_APY"), category: "LEND" }, { metric: m("SUPPLY_APY"), category: "LEND" }).rankable).toBe(true);
    const c = compareMetrics({ metric: m("SUPPLY_APY"), category: "LEND" }, { metric: m("SUPPLY_APY", "EARN", "4663:0x2"), category: "LEND" });
    expect(c.rankable).toBe(false);
    expect(c.caveats.join()).toMatch(/different assets/);
    expect(compareMetrics({ metric: m("SUPPLY_APY"), category: "LEND" }, { metric: m("BORROW_APY", "PAY"), category: "COLLATERAL" }).displayTogether).toBe(false);
  });
});

describe("ChainReader.getLogs", () => {
  const cfg = { url: "http://x", isPublicRpc: true, multicallChunkSize: 10, maxAttempts: 2, timeoutMs: 1000, retryBaseMs: 1 };
  const log = (n: bigint, i: number) => ({ address: "0x544BF81c855AE84c1e8b65d5E38770898D01EeE2", blockNumber: n, transactionHash: "0x" + "ab".repeat(32), logIndex: i, args: { market: "0x1" } });
  it("bisects ranges the provider rejects as too large and returns logs ordered by block/index", async () => {
    const calls: [bigint, bigint][] = [];
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push([fromBlock, toBlock]);
        if (toBlock - fromBlock > 250n) throw new Error("query returned more than 10000 results");
        return [log(900n, 2), log(900n, 1), log(10n, 0)].filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
    } as unknown as PublicClient;
    const r = await new ViemChainReader(cfg, client).getLogs({ address: "0x544BF81c855AE84c1e8b65d5E38770898D01EeE2", event: createNewMarketEvent, fromBlock: 0n, toBlock: 1000n });
    expect(r.map((l) => [l.blockNumber, l.logIndex])).toEqual([[10n, 0], [900n, 1], [900n, 2]]);
    expect(calls.length).toBeGreaterThan(1);
  });
  it("other failures throw (no silent partial list)", async () => {
    const client = { getLogs: async () => { throw new Error("execution reverted"); } } as unknown as PublicClient;
    await expect(new ViemChainReader(cfg, client).getLogs({ address: "0x544BF81c855AE84c1e8b65d5E38770898D01EeE2", event: createNewMarketEvent, fromBlock: 0n, toBlock: 10n })).rejects.toThrow();
  });
  it("classifies provider range errors", () => {
    expect(isLogRangeError(new Error("Log response size exceeded. query returned more than 10000 results"))).toBe(true);
    expect(isLogRangeError(new Error("block range is too wide"))).toBe(true);
    expect(isLogRangeError(new Error("execution reverted"))).toBe(false);
  });
});

describe("sanitizeSymbol", () => {
  it("keeps ordinary symbols and drops markup, control and bidi characters", () => {
    expect(sanitizeSymbol("PT-NVDA-15OCT2026")).toBe("PT-NVDA-15OCT2026");
    expect(sanitizeSymbol("PT-<img src=x onerror=1>‮\u0007")).toBe("PT-img srcx onerror1");
    expect(sanitizeSymbol(null)).toBe("");
    expect(sanitizeSymbol("A".repeat(100)).length).toBe(32);
  });
});
