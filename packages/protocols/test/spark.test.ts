/** Spark Savings (spUSDG): ray math and the adapter over a fake chain. */
import { describe, expect, it } from "vitest";
import { OpportunityEngine } from "@skein/engine/opportunities/engine";
import { apyFromPerSecondRay, RAY, rpow, SP_USDG, SparkSavingsAdapter } from "../src/spark/adapter.js";
import { defaultWorld, testStack, USDG, WALLET } from "@skein/testkit/world";

const LIVE_VSR = 1000000001090862085746321732n; // read 2026-09-24

describe("ray math", () => {
  it("rpow matches exact small cases", () => {
    expect(rpow(2n * RAY, 10n)).toBe(1024n * RAY);
    expect(rpow(RAY, 31_536_000n)).toBe(RAY);
    expect(rpow(3n * RAY, 0n)).toBe(RAY);
  });
  it("the live vsr annualises to 3.50 %", () => {
    const apy = apyFromPerSecondRay(LIVE_VSR);
    expect(Number(apy) / 1e16).toBeCloseTo(3.5, 3);
    expect(apyFromPerSecondRay(RAY - 1n)).toBe(0n);
  });
});

function world(opts: { asset?: string; cap?: bigint; total?: bigint; balance?: bigint } = {}) {
  const w = defaultWorld();
  const contracts = (w.contracts ??= new Map());
  contracts.set(SP_USDG.toLowerCase(), {
    vsr: LIVE_VSR,
    totalAssets: opts.total ?? 13_704_708_231_731n,
    asset: opts.asset ?? USDG,
    depositCap: opts.cap ?? 500_000_000_000_000n,
    decimals: 6,
    balanceOf: (a: readonly unknown[]) => (String(a[0]).toLowerCase() === WALLET.toLowerCase() ? (opts.balance ?? 0n) : 0n),
    convertToAssets: (a: readonly unknown[]) => ((a[0] as bigint) * 1_008_957n) / 1_000_000n,
  });
  return w;
}

async function engineFor(w: ReturnType<typeof defaultWorld>) {
  const s = await testStack({ world: w });
  return new OpportunityEngine([new SparkSavingsAdapter()], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
}

describe("Spark Savings adapter", () => {
  it("publishes one USDG VAULT opportunity with the computed APY and onchain TVL", async () => {
    const r = await (await engineFor(world())).getOpportunities({ eligibility: "ALL" });
    expect(r.status).toBe("COMPLETE");
    const o = r.data[0]!;
    expect(o.category).toBe("VAULT");
    expect(o.primaryAsset.symbol).toBe("USDG");
    expect(o.outputAssets[0]!.symbol).toBe("spUSDG");
    expect(Number(o.yields[0]!.value) / 1e16).toBeCloseTo(3.5, 3);
    expect(o.tvl?.value.amount?.raw).toBe(13_704_708_231_731n);
    expect(o.eligibility?.eligibleForDefaultDisplay).toBe(true);
  });
  it("refuses to publish when asset() is not the canonical USDG", async () => {
    const r = await (await engineFor(world({ asset: "0x000000000000000000000000000000000000bad1" }))).getOpportunities({ eligibility: "ALL" });
    expect(r.data).toEqual([]);
    expect(r.status).not.toBe("COMPLETE");
  });
  it("a full deposit cap closes entry", async () => {
    const r = await (await engineFor(world({ cap: 10n, total: 10n }))).getOpportunities({ eligibility: "ALL" });
    expect(r.data[0]!.eligibility?.excludedBy).toContain("DEPOSIT_DISABLED");
  });
  it("reads the wallet's spUSDG position onchain", async () => {
    const r = await (await engineFor(world({ balance: 1_000_000n }))).getUserPositions(WALLET);
    expect(r.data[0]!.kind).toBe("VAULT");
    expect(r.data[0]!.supplied?.value.amount?.raw).toBe(1_008_957n);
  });
});
