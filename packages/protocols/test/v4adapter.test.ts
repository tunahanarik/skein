/** Uniswap v4 hookless adapter over a fake StateView / V4Quoter. */
import { describe, expect, it } from "vitest";
import { OpportunityEngine } from "@skein/engine/opportunities/engine";
import { UNISWAP_RECORDED_ONLY } from "../src/uniswap/constants.js";
import { UniswapV4Adapter } from "../src/uniswap/v4adapter.js";
import { hooklessKey, poolIdOf, sqrtRatioAtTick, wordOf } from "../src/uniswap/v4math.js";
import { defaultWorld, NVDA, ONE, testStack, USDG } from "@skein/testkit/world";

// NVDA (18) / USDG (6): price ≈ 224 USDG per NVDA → token order decides the tick sign.
const key = hooklessKey(NVDA, USDG, 3000, 60);
const ID = poolIdOf(key).toLowerCase();
const nvdaIs0 = key.currency0.toLowerCase() === NVDA.toLowerCase();
// tick for price(token1/token0 in raw units): NVDA→USDG raw = 224e6/1e18 = 2.24e-10 ⇒ tick ≈ -222,240 (if NVDA is token0)
const TICK = nvdaIs0 ? -222_240 : 222_240;
const SQRT = sqrtRatioAtTick(TICK);
const L = 10n ** 17n;
const LO = TICK - 6000;
const HI = TICK + 6000;

function world(opts: { hookedOnly?: boolean } = {}) {
  const w = defaultWorld();
  const c = (w.contracts ??= new Map());
  const isOurs = (id: unknown) => !opts.hookedOnly && String(id).toLowerCase() === ID;
  c.set(UNISWAP_RECORDED_ONLY.v4StateView.toLowerCase(), {
    getSlot0: (a: readonly unknown[]) => (isOurs(a[0]) ? [SQRT, TICK, 0, 3000] : [0n, 0, 0, 0]),
    getLiquidity: (a: readonly unknown[]) => (isOurs(a[0]) ? L : 0n),
    getTickBitmap: (a: readonly unknown[]) => {
      if (!isOurs(a[0])) return 0n;
      let bm = 0n;
      for (const t of [LO, HI]) {
        const { word, bit } = wordOf(t, 60);
        if (word === Number(a[1])) bm |= 1n << BigInt(bit);
      }
      return bm;
    },
    getTickLiquidity: (a: readonly unknown[]) => (Number(a[1]) === LO ? [L, L] : Number(a[1]) === HI ? [L, -L] : [0n, 0n]),
  });
  c.set(UNISWAP_RECORDED_ONLY.v4Quoter.toLowerCase(), {
    quoteExactInputSingle: (a: readonly unknown[]) => {
      const p = a[0] as { poolKey: { hooks: string }; zeroForOne: boolean; exactAmount: bigint };
      if (p.poolKey.hooks !== "0x0000000000000000000000000000000000000000") throw new Error("execution reverted");
      const sellNvda = p.zeroForOne === nvdaIs0;
      return [sellNvda ? (p.exactAmount * 223n) / 10n ** 12n : (p.exactAmount * 10n ** 12n) / 225n, 90_000n];
    },
  });
  return w;
}

async function engine(opts: Parameters<typeof world>[0] = {}) {
  const s = await testStack({ world: world(opts) });
  return new OpportunityEngine([new UniswapV4Adapter()], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
}

describe("Uniswap v4 hookless adapter", () => {
  it("finds the initialized hookless pool by computed id; reserves come from the tick walk (lower bound)", async () => {
    const e = await engine();
    const r = await e.getTradeMarkets();
    expect(r.data).toHaveLength(1);
    const m = r.data[0]!;
    expect(m.id).toBe(`4663:uniswap-v4:uniswap-v4-pool:${ID}`);
    expect(m.originVerified).toBe(true);
    expect(m.state).toBe("ACTIVE");
    expect(m.liquidity.reserves).toHaveLength(2);
    expect(m.liquidity.reserves.every((x) => (x.value.amount?.raw ?? 0n) > 0n)).toBe(true);
    expect(m.warnings.some((w) => w.code === "RESERVES_LOWER_BOUND")).toBe(true);
  });

  it("quotes through the V4Quoter", async () => {
    const e = await engine();
    const routes = await e.getTradeRoutes(`4663:${NVDA.toLowerCase()}`, `4663:${USDG.toLowerCase()}`);
    const q = await e.getTradeQuote(routes.data.direct[0]!, ONE);
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.quote.expectedOutput.raw).toBe(223_000_000n);
  });

  it("publishes nothing when no hookless pool is initialized", async () => {
    const e = await engine({ hookedOnly: true });
    expect((await e.getTradeMarkets()).data).toEqual([]);
  });
});
