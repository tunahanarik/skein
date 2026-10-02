/** Price charts: resampling, share → token conversion, identity check, incremental Chainlink history. */
import { describe, expect, it } from "vitest";
import { ChainlinkRounds, deviation, resample, shareToToken, summarize } from "../src/charts.js";
import { fetchShareHistory } from "@skein/robinhood/sources/rhMarket";

const E18 = 10n ** 18n;

describe("resample", () => {
  it("takes the last value per bucket, carries it forward, and seeds from before the window", () => {
    const pts = [
      { t: 50, v: 1n }, // before the window: seeds the first bucket
      { t: 120, v: 2n },
      { t: 150, v: 3n }, // last in bucket [100,200)
      { t: 420, v: 4n },
    ];
    expect(resample(pts, 100, 500, 100).map((p) => [p.t, p.v])).toEqual([
      [100, 3n],
      [200, 3n],
      [300, 3n],
      [400, 4n],
      [500, 4n],
    ]);
  });
  it("starts at the first value when nothing precedes the window", () => {
    expect(resample([{ t: 250, v: 7n }], 100, 400, 100).map((p) => p.t)).toEqual([200, 300, 400]);
  });
});

describe("share data", () => {
  it("token price = share close × multiplier, exact", () => {
    const [p] = shareToToken([{ t: 1, close: "229.50", extended: true }], 1_000775159164630595n);
    expect(p!.v).toBe((22950n * 10n ** 16n * 1_000775159164630595n) / E18);
    expect(p!.ext).toBe(true);
  });
  it("deviation is relative to the reference", () => {
    expect(deviation(105n, 100n)).toBeCloseTo(0.05);
    expect(deviation(95n, 100n)).toBeCloseTo(0.05);
    expect(deviation(1n, 0n)).toBe(Infinity);
  });
  it("summary: first/last/high/low/change and an explicit since", () => {
    const s = summarize("1D", [{ t: 0, v: 100n * E18 }, { t: 1, v: 120n * E18 }, { t: 2, v: 110n * E18 }], 18, null);
    expect([s.first, s.high, s.low, s.last]).toEqual(["100", "120", "100", "110"]);
    expect(Number(s.changePct)).toBeCloseTo(10);
    expect(s.since).toBeNull();
  });
  it("drops interpolated bars and refuses a response for another symbol", async () => {
    const body = (symbol: string) => ({ symbol, historicals: [{ begins_at: "2026-01-01T00:00:00Z", close_price: "1.00", interpolated: true }, { begins_at: "2026-01-02T00:00:00Z", close_price: "2.00", session: "reg", interpolated: false }] });
    const f = (symbol: string) => (async () => new Response(JSON.stringify(body(symbol)), { status: 200 })) as unknown as typeof fetch;
    const bars = await fetchShareHistory("NVDA", "1Y", f("NVDA"));
    expect(bars.map((b) => b.close)).toEqual(["2.00"]);
    await expect(fetchShareHistory("NVDA", "1Y", f("NVDX"))).rejects.toThrow("symbol mismatch");
    await expect(fetchShareHistory("../x", "1Y", f("NVDA"))).rejects.toThrow("bad symbol");
  });
});

describe("ChainlinkRounds", () => {
  it("backfills the phase once, then reads only new rounds", async () => {
    const phase = 1n << 64n;
    let latestAgg = 5n;
    const reads: bigint[] = [];
    const reader = {
      async multicall(calls: readonly { functionName: string; args?: readonly unknown[] }[]) {
        return calls.map((c) => {
          if (c.functionName === "decimals") return { status: "success", result: 8 };
          if (c.functionName === "latestRoundData") return { status: "success", result: [phase | latestAgg, 100n, 0n, 1000n + latestAgg, phase | latestAgg] };
          const id = c.args![0] as bigint;
          const agg = id & ((1n << 64n) - 1n);
          reads.push(agg);
          return { status: "success", result: [id, 100n + agg, 0n, 1000n + agg, id] };
        });
      },
    };
    const store = new ChainlinkRounds(reader as never, { batch: 2 });
    const a = await store.get("0x0000000000000000000000000000000000000001", 1n);
    expect(a.decimals).toBe(8);
    expect(a.rounds.map((r) => r.v)).toEqual([101n, 102n, 103n, 104n, 105n]);
    expect(reads).toEqual([1n, 2n, 3n, 4n, 5n]);
    reads.length = 0;
    latestAgg = 7n;
    const b = await store.get("0x0000000000000000000000000000000000000001", 2n);
    expect(reads).toEqual([6n, 7n]); // incremental
    expect(b.rounds.at(-1)).toEqual({ t: 1007_000, v: 107n });
  });
});
