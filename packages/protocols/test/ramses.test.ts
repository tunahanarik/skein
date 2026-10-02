/** Ramses CL through the shared v3 adapter: tickSpacing-keyed pools, dynamic fee, tickSpacing quoter. */
import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import { OpportunityEngine } from "@skein/engine/opportunities/engine";
import { RAMSES_CL } from "../src/ramses/dialect.js";
import { UniswapAdapter } from "../src/uniswap/adapter.js";
import { Q192 } from "../src/uniswap/math.js";
import { MemoryPoolListStore } from "../src/uniswap/poolStore.js";
import { sqrtPriceFor } from "@skein/testkit/uniswap";
import { defaultWorld, NVDA, ONE, testStack, USDG } from "@skein/testkit/world";

const POOL = "0x000000000000000000000000000000000000d001" as Address;
const FACTORY = RAMSES_CL.factory;

function install(opts: { dynamicFee?: number; factoryOverride?: Address; quoteCalls?: { n: number } } = {}) {
  const w = defaultWorld();
  const c = (w.contracts ??= new Map());
  const [t0, t1] = BigInt(NVDA) < BigInt(USDG) ? [NVDA, USDG] : [USDG, NVDA];
  const sqrt = t0 === NVDA ? sqrtPriceFor(22_441_382_169n, 100_009_000n, 18, 6) : sqrtPriceFor(100_009_000n, 22_441_382_169n, 6, 18);
  const fee = opts.dynamicFee ?? 140;
  c.set(FACTORY.toLowerCase(), {
    getPool: (a: readonly unknown[]) => {
      const [x, y, ts] = a as [string, string, number];
      const match = Number(ts) === 10 && [x, y].map((s) => s.toLowerCase()).sort().join() === [NVDA, USDG].map((s) => s.toLowerCase()).sort().join();
      return match ? POOL : "0x0000000000000000000000000000000000000000";
    },
  });
  c.set(POOL.toLowerCase(), { factory: opts.factoryOverride ?? FACTORY, token0: t0, token1: t1, fee, tickSpacing: 10, slot0: [sqrt, 0, 0, 1, 1, 0, true], liquidity: 10n ** 20n });
  c.set(RAMSES_CL.quoter.toLowerCase(), {
    quoteExactInputSingle: (a: readonly unknown[]) => {
      if (opts.quoteCalls) opts.quoteCalls.n++;
      const p = a[0] as { tokenIn: string; amountIn: bigint; tickSpacing?: number; fee?: number };
      if (p.tickSpacing !== 10 || p.fee !== undefined) throw new Error("execution reverted: wrong key");
      const zeroForOne = p.tokenIn.toLowerCase() === t0.toLowerCase();
      const inAfterFee = (p.amountIn * BigInt(1_000_000 - fee)) / 1_000_000n;
      const sq = sqrt * sqrt;
      const out = zeroForOne ? (inAfterFee * sq) / Q192 : (inAfterFee * Q192) / sq;
      return [(out * 999n) / 1000n, sqrt, 1, 80_000n];
    },
  });
  for (const [t, b] of [[NVDA, 500n * ONE], [USDG, 110_000_000_000n]] as const) {
    const m = w.balances.get(t.toLowerCase()) ?? new Map<string, bigint>();
    m.set(POOL.toLowerCase(), b);
    w.balances.set(t.toLowerCase(), m);
  }
  (w.logs ??= []).push({ address: FACTORY, eventName: "PoolCreated", blockNumber: 60_500_000n, logIndex: 1, args: { token0: t0, token1: t1, fee: 500, tickSpacing: 10, pool: POOL } });
  return w;
}

async function run(opts: Parameters<typeof install>[0] = {}) {
  const s = await testStack({ world: install(opts) });
  const engine = new OpportunityEngine([new UniswapAdapter({ dialect: RAMSES_CL, store: new MemoryPoolListStore() })], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
  return engine;
}

describe("Ramses CL dialect", () => {
  it("discovers and verifies a tickSpacing-keyed pool; the market carries the DYNAMIC fee read at the block", async () => {
    const engine = await run();
    const r = await engine.getTradeMarkets();
    const m = r.data.find((x) => x.address?.toLowerCase() === POOL.toLowerCase())!;
    expect(m.protocol.id).toBe("ramses");
    expect(m.id).toBe(`4663:ramses:ramses-cl-pool:${POOL.toLowerCase()}`);
    expect(m.fee?.value).toEqual({ ppm: 140, kind: "DYNAMIC" });
    expect(m.originVerified).toBe(true);
    expect(m.verificationStatus).toBe("VERIFIED_ONCHAIN");
    const opp = (await engine.getOpportunities({ eligibility: "ALL" })).data.find((o) => o.primaryAsset.symbol === "NVDA")!;
    expect(opp.title).toMatch(/Ramses CL \(0\.014% dynamic fee pool\)/);
  });

  it("quotes through the tickSpacing-keyed QuoterV2 with the dynamic fee", async () => {
    const calls = { n: 0 };
    const engine = await run({ quoteCalls: calls });
    const routes = await engine.getTradeRoutes(`4663:${NVDA.toLowerCase()}`, `4663:${USDG.toLowerCase()}`);
    const q = await engine.getTradeQuote(routes.data.direct[0]!, ONE);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    expect(calls.n).toBe(1);
    expect(Number(q.quote.expectedOutput.display)).toBeGreaterThan(220);
    expect(q.quote.fees![0]!.amount.raw).toBe((ONE * 140n) / 1_000_000n);
  });

  it("refuses a pool whose factory() is not the Ramses factory", async () => {
    const engine = await run({ factoryOverride: "0x000000000000000000000000000000000000fac7" });
    const r = await engine.getTradeMarkets();
    const m = r.data.find((x) => x.address?.toLowerCase() === POOL.toLowerCase());
    expect(m?.originVerified ?? false).toBe(false);
  });
});
