/** Live prices: one read for everything watched, snapshot on subscribe, then only changes. */
import { describe, expect, it } from "vitest";
import { LiveHub, type LiveMarket } from "../src/live.js";

const Q96 = 1n << 96n;
const NVDA = { key: "4663:nvda", symbol: "NVDA", decimals: 18 };
const USDG = { key: "4663:usdg", symbol: "USDG", decimals: 6 };
const market: LiveMarket = { id: "m1", venue: "Uniswap v3", kind: "V3", target: "0x00000000000000000000000000000000000000a1", feePpm: 500, tvlUsd: "1000", a0: NVDA, a1: USDG };

function setup() {
  let sqrt = Q96 / 1000n; // any non-zero price
  let answer = 23000000000n; // 230.00 at 8 decimals
  let reads = 0;
  const reader = {
    async getLatestBlock() {
      return { number: 100n, hash: "0x", timestamp: 0 };
    },
    async multicall(calls: readonly { functionName: string }[]) {
      reads++;
      return calls.map((c) => (c.functionName === "slot0" ? { status: "success", result: [sqrt, 0, 0, 0, 0, 0, true] } : { status: "success", result: [1n, answer, 0n, 1_700_000_000n, 1n] }));
    },
  };
  const source = {
    async marketsFor(k: string) {
      return k === NVDA.key ? [market] : [];
    },
    async feedFor(k: string) {
      return k === NVDA.key ? { key: NVDA.key, symbol: "NVDA", proxy: "0x00000000000000000000000000000000000000f1" as const, decimals: 8 } : null;
    },
  };
  const hub = new LiveHub(reader as never, source, { pollMs: 3_600_000 });
  return {
    hub,
    setSqrt: (v: bigint) => (sqrt = v),
    setAnswer: (v: bigint) => (answer = v),
    reads: () => reads,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("LiveHub", () => {
  it("sends a snapshot on subscribe, then only what changed", async () => {
    const env = setup();
    const events: [string, Record<string, unknown>][] = [];
    const stop = env.hub.subscribe({ pairs: [NVDA.key], prices: [] }, (e, d) => events.push([e, d as Record<string, unknown>]));
    for (let i = 0; i < 5; i++) await tick();
    const snap = events.find(([e]) => e === "snapshot")![1] as { pairs: { id: string; price: string }[]; prices: { usd: string }[] };
    expect(snap.pairs.map((p) => p.id)).toEqual(["m1"]);
    expect(snap.prices.map((p) => p.usd)).toEqual(["230"]);

    events.length = 0;
    await env.hub.poll(); // nothing changed: only the block heartbeat
    expect(events.map(([e]) => e)).toEqual(["block"]);
    expect(events[0]![1].block).toBe("100");

    env.setSqrt(Q96 / 999n);
    env.setAnswer(23100000000n);
    events.length = 0;
    await env.hub.poll();
    expect(events.map(([e]) => e).sort()).toEqual(["block", "pair", "price"]);
    expect(events.find(([e]) => e === "price")![1].usd).toBe("231");
    stop();
    expect(env.hub.size).toBe(0);
  });

  it("does not read the chain when nobody is watching", async () => {
    const env = setup();
    await env.hub.poll();
    expect(env.reads()).toBe(0);
  });

  it("only sends a subscriber its own assets", async () => {
    const env = setup();
    const other: string[] = [];
    const stop = env.hub.subscribe({ pairs: [], prices: ["4663:weth"] }, (e) => other.push(e));
    const stop2 = env.hub.subscribe({ pairs: [NVDA.key], prices: [] }, () => undefined);
    for (let i = 0; i < 5; i++) await tick();
    env.setSqrt(Q96 / 7n);
    await env.hub.poll();
    expect(other.filter((e) => e === "pair")).toEqual([]);
    stop();
    stop2();
  });
});
