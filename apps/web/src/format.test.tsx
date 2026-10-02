import { describe, expect, it } from "vitest";
import { humanDates, pct, prettyId } from "./format";

describe("format: no dashes in what people read", () => {
  it("writes negative percentages with a real minus sign", () => {
    expect(pct(-0.55, 2)).toBe("−0.55%");
    expect(pct(1.2, 1)).toBe("1.2%");
  });

  it("drops the sign when a value rounds to zero", () => {
    expect(pct(-0.001, 2)).toBe("0.00%");
    expect(pct(-0.04, 1)).toBe("0.0%");
  });

  it("turns machine ids into words", () => {
    expect(prettyId("uniswap-v4")).toBe("Uniswap v4");
    expect(prettyId("beefy-api")).toBe("Beefy API");
    expect(prettyId("official_api")).toBe("Official API");
    expect(prettyId("KyberSwap · uniswap-v3, pancake-v3")).toBe("KyberSwap · Uniswap v3, Pancake v3");
    expect(prettyId("LI.FI")).toBe("LI.FI");
  });

  it("formats ISO dates inside server text for English readers", () => {
    expect(humanDates("Pendle, matures 2026-10-15")).toBe("Pendle, matures Oct 15, 2026");
    expect(humanDates("at or after 2027-03-25T00:00:00Z, paid in SY")).toBe("at or after Mar 25, 2027, paid in SY");
    expect(humanDates("no dates here")).toBe("no dates here");
  });
});
