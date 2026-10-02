import { describe, expect, it } from "vitest";
import {
  effectiveMultiplier,
  parseMultiplier,
  relativeDeviation,
  calculateStockDisplayBalance,
  stockTokenUsdE18,
  tokenPriceFromUnderlying,
  underlyingFromTokenPrice,
  underlyingMidFromQuote,
  type TokenPrice,
} from "../src/lib/stockToken.js";
import { formatFixed, parseFixed } from "../src/lib/units.js";

// Live values read 2026-09-24 (docs/research/stock-tokens.md): NVDA uiMultiplier.
const NVDA_MULT = 1000775159164630595n;
const ONE = 10n ** 18n;

describe("share-equivalent balance (balanceOfUI)", () => {
  it("is the raw balance when the multiplier is 1.0", () => {
    expect(calculateStockDisplayBalance(5n * ONE, ONE).displayShareBalanceRaw).toBe(5n * ONE);
  });

  it("scales by the multiplier and floors like the contract", () => {
    // 10 NVDA tokens → 10.00775159164630595 share-equivalents
    expect(formatFixed(calculateStockDisplayBalance(10n * ONE, NVDA_MULT).displayShareBalanceRaw, 18)).toBe("10.00775159164630595");
  });

  it("applies a 4:1 split as multiplier 4.0 without touching the raw balance", () => {
    expect(calculateStockDisplayBalance(3n * ONE, 4n * ONE).displayShareBalanceRaw).toBe(12n * ONE);
  });

  it("rejects a zero multiplier instead of zeroing balances", () => {
    expect(() => calculateStockDisplayBalance(ONE, 0n)).toThrow(RangeError);
  });
});

describe("USD valuation never applies the multiplier twice", () => {
  // Chainlink NVDA feed, 8 decimals, token price (multiplier inside): $225.54970149
  const feed: TokenPrice = { kind: "TOKEN_PRICE", raw: 22554970149n, decimals: 8 };

  it("token price × raw balance", () => {
    const usd = stockTokenUsdE18(2n * ONE, 18, feed, NVDA_MULT);
    expect(formatFixed(usd, 18)).toBe("451.09940298");
  });

  it("the same holding valued from the underlying price agrees with the token price", () => {
    const underlying = underlyingFromTokenPrice(feed, NVDA_MULT);
    const viaUnderlying = stockTokenUsdE18(2n * ONE, 18, underlying, NVDA_MULT);
    const viaToken = stockTokenUsdE18(2n * ONE, 18, feed, NVDA_MULT);
    // integer division in the round trip may lose at most a few wei of USD
    const diff = viaToken > viaUnderlying ? viaToken - viaUnderlying : viaUnderlying - viaToken;
    expect(diff < 10n ** 12n).toBe(true);
  });

  it("the multiplier changes the value of an underlying quote but not of a token quote", () => {
    const underlying = underlyingMidFromQuote("100", "100", 8)!;
    expect(formatFixed(stockTokenUsdE18(ONE, 18, underlying, 4n * ONE), 18)).toBe("400");
    const token: TokenPrice = { kind: "TOKEN_PRICE", raw: 400n * 10n ** 8n, decimals: 8 };
    expect(formatFixed(stockTokenUsdE18(ONE, 18, token, 4n * ONE), 18)).toBe("400");
  });

  it("round-trips underlying → token price", () => {
    const u = { kind: "UNDERLYING_PRICE" as const, raw: parseFixed("225.375", 18), decimals: 18 };
    const t = tokenPriceFromUnderlying(u, NVDA_MULT);
    expect(underlyingFromTokenPrice(t, NVDA_MULT).raw).toBeGreaterThanOrEqual(u.raw - 1n);
  });
});

describe("Robinhood /rhj/prices quote handling", () => {
  it("takes the mid of bid and ask", () => {
    const mid = underlyingMidFromQuote("336.38", "336.4", 18)!;
    expect(formatFixed(mid.raw, 18)).toBe("336.39");
    expect(mid.kind).toBe("UNDERLYING_PRICE");
  });

  it('treats "0" as unavailable, not as a price', () => {
    expect(underlyingMidFromQuote("0", "336.4")).toBeNull();
    expect(underlyingMidFromQuote("336.38", "0")).toBeNull();
  });

  it("rejects crossed or garbage quotes", () => {
    expect(underlyingMidFromQuote("337", "336")).toBeNull();
    expect(underlyingMidFromQuote("abc", "1")).toBeNull();
    expect(underlyingMidFromQuote("-1", "1")).toBeNull();
  });
});

describe("multiplier parsing and scheduling", () => {
  it("parses the API's decimal multiplier exactly", () => {
    expect(parseMultiplier("1.000566080061092436")).toBe(1000566080061092436n);
    expect(parseMultiplier("4")).toBe(4n * ONE);
  });

  it("rejects precision beyond 18 decimals instead of truncating", () => {
    expect(() => parseMultiplier("1.0000000000000000001")).toThrow(RangeError);
  });

  it("switches to the pending multiplier only once its effective time has passed", () => {
    const snap = { current: ONE, pending: 4n * ONE, pendingEffectiveAt: 1_800_000_000 };
    expect(effectiveMultiplier(snap, 1_799_999_999)).toBe(ONE);
    expect(effectiveMultiplier(snap, 1_800_000_000)).toBe(4n * ONE);
    expect(effectiveMultiplier({ current: NVDA_MULT }, 2_000_000_000)).toBe(NVDA_MULT);
  });
});

describe("oracle cross-check", () => {
  it("measures the gap a double-applied multiplier produces", () => {
    const correct: TokenPrice = { kind: "TOKEN_PRICE", raw: 22554970149n, decimals: 8 };
    const doubled = tokenPriceFromUnderlying({ kind: "UNDERLYING_PRICE", raw: correct.raw, decimals: 8 }, NVDA_MULT);
    expect(relativeDeviation(doubled, correct)).toBeCloseTo(0.000775159, 6);
  });

  it("compares prices at different decimals", () => {
    const a: TokenPrice = { kind: "TOKEN_PRICE", raw: 100n * 10n ** 8n, decimals: 8 };
    const b: TokenPrice = { kind: "TOKEN_PRICE", raw: 101n * 10n ** 18n, decimals: 18 };
    expect(relativeDeviation(a, b)).toBeCloseTo(1 / 101, 8);
  });
});
