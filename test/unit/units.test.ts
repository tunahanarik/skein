import { describe, expect, it } from "vitest";
import { formatFixed, parseFixed, rescale, usdE18ToNumber, usdValueE18 } from "../../src/lib/units.js";

describe("decimal conversion", () => {
  it("formats raw amounts exactly, trimming trailing zeros", () => {
    expect(formatFixed(1_500_000n, 6)).toBe("1.5"); // 1.5 USDG
    expect(formatFixed(1n, 18)).toBe("0.000000000000000001");
    expect(formatFixed(0n, 18)).toBe("0");
    expect(formatFixed(-2_500_000n, 6)).toBe("-2.5");
    expect(formatFixed(123n, 0)).toBe("123");
  });

  it("keeps precision a float would lose", () => {
    // 2^53 + 1 wei: Number() would round this
    const raw = 9_007_199_254_740_993n;
    expect(formatFixed(raw, 0)).toBe("9007199254740993");
  });

  it("parses decimal strings and rejects non-numbers", () => {
    expect(parseFixed("336.38", 6)).toBe(336_380_000n);
    expect(parseFixed("0.5", 18)).toBe(5n * 10n ** 17n);
    expect(parseFixed("1.50000", 2)).toBe(150n); // trailing zeros beyond scale are fine
    expect(() => parseFixed("1.234", 2)).toThrow(RangeError); // real digits beyond scale are not
    expect(() => parseFixed("1e5", 18)).toThrow(RangeError);
    expect(() => parseFixed("", 18)).toThrow(RangeError);
  });

  it("rescales between token decimals", () => {
    expect(rescale(1_000_000n, 6, 18)).toBe(10n ** 18n);
    expect(rescale(1_999_999_999_999n, 18, 6)).toBe(1n); // floors
  });

  it("rejects unsupported decimals", () => {
    expect(() => formatFixed(1n, -1)).toThrow(RangeError);
    expect(() => formatFixed(1n, 1.5)).toThrow(RangeError);
  });
});

describe("USD valuation", () => {
  it("values a 6-decimal stablecoin at an 8-decimal price", () => {
    // 1,234.56 USDG at $0.99995
    const usd = usdValueE18(1_234_560_000n, 6, 99_995_000n, 8);
    expect(formatFixed(usd, 18)).toBe("1234.498272");
  });

  it("values an 18-decimal token without float error", () => {
    // 0.1 WETH at $2,672.06
    const usd = usdValueE18(10n ** 17n, 18, 267_206_000_000n, 8);
    expect(formatFixed(usd, 18)).toBe("267.206");
    expect(usdE18ToNumber(usd)).toBe(267.206);
  });

  it("zero price → zero value; negative price is an error", () => {
    expect(usdValueE18(10n ** 18n, 18, 0n, 8)).toBe(0n);
    expect(() => usdValueE18(10n ** 18n, 18, -1n, 8)).toThrow(RangeError);
  });
});
