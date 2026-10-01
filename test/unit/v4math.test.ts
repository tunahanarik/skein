/** Uniswap v4 math: TickMath port, poolId, window reserves. */
import { describe, expect, it } from "vitest";
import { amount0For, amount1For, hooklessKey, poolIdOf, Q96, sqrtRatioAtTick, ticksInWord, windowReserves, wordOf } from "../../src/protocols/uniswap/v4math.js";

describe("TickMath port", () => {
  it("matches Uniswap's constants", () => {
    expect(sqrtRatioAtTick(0)).toBe(Q96);
    expect(sqrtRatioAtTick(-887272)).toBe(4295128739n); // MIN_SQRT_RATIO
    expect(sqrtRatioAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n); // MAX_SQRT_RATIO
    // 1.0001^1 ≈ 1.00005 in sqrt
    expect(Number(sqrtRatioAtTick(1)) / Number(Q96)).toBeCloseTo(Math.sqrt(1.0001), 12);
    expect(Number(sqrtRatioAtTick(-60000)) / Number(Q96)).toBeCloseTo(Math.sqrt(1.0001 ** -60000), 10);
  });
});

describe("poolId", () => {
  it("is the live NVDA/USDG 0.3 % hookless pool id (read 2026-09-24)", () => {
    const k = hooklessKey("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", 3000, 60);
    expect(poolIdOf(k).toLowerCase()).toBe("0x3bb34a44f1b2b5f32c034c38a53065a521a47b199700fa9bd19d60985ff24bf1");
    expect(k.hooks).toBe("0x0000000000000000000000000000000000000000");
  });
});

describe("bitmap helpers", () => {
  it("words and bits follow floor division for negative ticks", () => {
    expect(wordOf(-60, 60)).toEqual({ word: -1, bit: 255 });
    expect(wordOf(0, 60)).toEqual({ word: 0, bit: 0 });
    expect(ticksInWord(-1, 1n << 255n, 60)).toEqual([-60]);
  });
});

describe("windowReserves", () => {
  it("a single range around the price equals the closed-form amounts", () => {
    const L = 10n ** 18n;
    const lo = -600, hi = 600;
    const sp = sqrtRatioAtTick(0);
    const r = windowReserves({ sqrtPriceX96: sp, tick: 0, liquidity: L, lo: -10000, hi: 10000, nets: new Map([[lo, L], [hi, -L]]) });
    expect(r.amount0).toBe(amount0For(sp, sqrtRatioAtTick(hi), L));
    expect(r.amount1).toBe(amount1For(sqrtRatioAtTick(lo), sp, L));
  });
  it("a range entirely above holds only token0; liquidity beyond the window is excluded (lower bound)", () => {
    const L = 10n ** 18n;
    const r = windowReserves({ sqrtPriceX96: sqrtRatioAtTick(0), tick: 0, liquidity: 0n, lo: -1000, hi: 1000, nets: new Map([[600, L], [1200, -L]]) });
    expect(r.amount1).toBe(0n);
    expect(r.amount0).toBe(amount0For(sqrtRatioAtTick(600), sqrtRatioAtTick(1000), L));
  });
});
