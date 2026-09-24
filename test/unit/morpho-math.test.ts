import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { fixed18FromNumber, formatPercent, mulDivUp, ratio18, WAD } from "../../src/lib/fixed.js";
import { checkOracle, expectedOraclePrice } from "../../src/protocols/morpho/oracleCheck.js";
import { liquidationIncentiveFactor, marketIdOf, maxBorrowAssets, toAssetsDown, toAssetsUp } from "../../src/protocols/morpho/onchain.js";
import { NVDA_MULT, ONE } from "../fixtures/world.js";

describe("Fixed18 conversion of protocol-supplied floats", () => {
  it("uses the number's exact decimal representation", () => {
    expect(fixed18FromNumber(0.04538947)).toBe(45_389_470_000_000_000n);
    expect(fixed18FromNumber(0.040311332388968946)).toBe(40_311_332_388_968_946n);
    expect(fixed18FromNumber(0)).toBe(0n);
    expect(fixed18FromNumber(108.54)).toBe(108_540_000_000_000_000_000n); // 10,854 %
  });

  it("expands exponent notation and floors beyond 18 decimals", () => {
    expect(fixed18FromNumber(1e-7)).toBe(100_000_000_000n);
    expect(fixed18FromNumber(3.5e-5)).toBe(35_000_000_000_000n);
    expect(fixed18FromNumber(1.23456789e-19)).toBe(0n);
    expect(fixed18FromNumber(-0.01)).toBe(-10_000_000_000_000_000n);
    expect(() => fixed18FromNumber(Number.NaN)).toThrow(RangeError);
    expect(() => fixed18FromNumber(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("formats percentages without float math", () => {
    expect(formatPercent(45_389_470_000_000_000n)).toBe("4.53%");
    expect(formatPercent(625n * 10n ** 15n, 1)).toBe("62.5%");
    expect(formatPercent(0n)).toBe("0.00%");
    expect(formatPercent(WAD)).toBe("100.00%");
  });
});

describe("Morpho formulas (morpho-blue v1 source)", () => {
  it("market id = keccak256(abi.encode(MarketParams)) — real Robinhood Chain NVDA/USDG market", () => {
    // Phase 0 evidence (docs/research/morpho.md): market 0x6630…4edc
    const id = marketIdOf({
      loanToken: getAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168"),
      collateralToken: getAddress("0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"),
      oracle: getAddress("0xc5b8a6c5fdf14f9744db1c8595f49e42ce23031a"),
      irm: getAddress("0x2bd3d5965b26b51814ac95127b2b80dd6ccc0fa1"),
      lltv: 625n * 10n ** 15n,
    });
    expect(id).toBe("0x66306c087add8907752320b309934abcc354d21626de8115c79df49d9c214edc");
  });

  it("liquidation incentive factor: min(1.15, 1/(1 − 0.3(1 − LLTV)))", () => {
    expect(liquidationIncentiveFactor(625n * 10n ** 15n)).toBe(1_126_760_563_380_281_690n); // 1/0.8875
    expect(liquidationIncentiveFactor(915n * 10n ** 15n)).toBe(1_026_167_265_264_238_070n); // 1/0.9745
    expect(liquidationIncentiveFactor(385n * 10n ** 15n)).toBe(115n * 10n ** 16n); // capped at 1.15
    expect(liquidationIncentiveFactor(WAD)).toBe(WAD);
  });

  it("shares ↔ assets with virtual shares, rounding in the protocol's favour", () => {
    // 1e6 virtual shares, 1 virtual asset
    expect(toAssetsDown(1_000_000n, 0n, 0n)).toBe(1n);
    expect(toAssetsDown(10n ** 18n, 1_000_000n, 10n ** 12n)).toBe(1_000_000_000_000n); // 1e18 × 1000001 / 1000001000000
    expect(toAssetsUp(3n, 10n, 7n)).toBe(1n); // ceil(3 × 11 / 1000007)
    expect(toAssetsDown(3n, 10n, 7n)).toBe(0n);
  });

  it("maxBorrow = floor(floor(collateral × price / 1e36) × LLTV / 1e18)", () => {
    // 2 NVDA at 224.39 USDG (6 dp) per NVDA (18 dp): price = 224.39e6 × 1e36 / 1e18
    const price = 22_439n * 10n ** 4n * 10n ** 18n;
    expect(maxBorrowAssets(2n * ONE, price, 625n * 10n ** 15n)).toBe(280_487_500n); // 448.78 × 0.625 = 280.4875 USDG
    expect(maxBorrowAssets(0n, price, 625n * 10n ** 15n)).toBe(0n);
  });

  it("large integers stay exact", () => {
    const huge = 2n ** 128n - 1n;
    expect(ratio18(huge, huge)).toBe(WAD);
    expect(mulDivUp(huge, 3n, 2n)).toBe((huge * 3n + 1n) / 2n);
  });
});

describe("oracle multiplier check", () => {
  const coll = { raw: 22_441_382_169n, decimals: 8 };
  const loan = { raw: 100_009_000n, decimals: 8 };
  const expected = expectedOraclePrice(coll, loan, 18, 6)!;
  const base = { collateralDecimals: 18, loanDecimals: 6, collateralPrice: coll, collateralPriceIsChainlink: true, loanPrice: loan, isStockTokenCollateral: true, multiplier: NVDA_MULT };

  it("expected price has the Morpho scale (1e36 × 10^(loanDec − collDec))", () => {
    // 224.41382169 / 1.00009 ≈ 224.3936 USDG per NVDA → ≈ 2.2439e26
    expect(expected / 10n ** 21n).toBe(224_393n);
  });

  it("CONSISTENT when the oracle equals the independent price", () => {
    expect(checkOracle({ ...base, oraclePrice: expected }).multiplierCheck).toBe("CONSISTENT");
  });

  it("DOUBLE_APPLIED when oracle / expected = uiMultiplier", () => {
    const r = checkOracle({ ...base, oraclePrice: (expected * NVDA_MULT) / ONE });
    expect(r.multiplierCheck).toBe("DOUBLE_APPLIED");
    expect(r.multiplierCheckDetail).toMatch(/applied twice/);
  });

  it("detects a small multiplier exactly (GOOGL-like m = 1.000193924414112587)", () => {
    const m = 1_000_193_924_414_112_587n;
    expect(checkOracle({ ...base, multiplier: m, oraclePrice: (expected * m) / ONE }).multiplierCheck).toBe("DOUBLE_APPLIED");
    expect(checkOracle({ ...base, multiplier: m, oraclePrice: expected }).multiplierCheck).toBe("CONSISTENT");
  });

  it("recognizes an oracle that assumes the loan asset is exactly $1 (ratio = loan USD price)", () => {
    const pegged = (expected * 100_009_000n) / 100_000_000n; // × 1.00009
    expect(checkOracle({ ...base, oraclePrice: pegged })).toMatchObject({ multiplierCheck: "CONSISTENT", loanPegAssumed: true });
    expect(checkOracle({ ...base, oraclePrice: (pegged * NVDA_MULT) / ONE })).toMatchObject({ multiplierCheck: "DOUBLE_APPLIED", loanPegAssumed: true });
  });

  it("INCONCLUSIVE when the ratio matches no known structure (never silently CONSISTENT)", () => {
    expect(checkOracle({ ...base, oraclePrice: (expected * 1_003n) / 1_000n }).multiplierCheck).toBe("INCONCLUSIVE");
  });

  it("NOT_DETECTABLE when uiMultiplier ≈ 1 (a double application would be invisible)", () => {
    expect(checkOracle({ ...base, multiplier: ONE, oraclePrice: expected }).multiplierCheck).toBe("NOT_DETECTABLE");
  });

  it("DEVIATES beyond 2 %, UNCHECKED without an exact (Chainlink) price or without prices", () => {
    expect(checkOracle({ ...base, oraclePrice: (expected * 105n) / 100n }).multiplierCheck).toBe("DEVIATES");
    expect(checkOracle({ ...base, collateralPriceIsChainlink: false, oraclePrice: (expected * NVDA_MULT) / ONE }).multiplierCheck).toBe("UNCHECKED");
    expect(checkOracle({ ...base, loanPrice: null, oraclePrice: expected }).multiplierCheck).toBe("UNCHECKED");
    expect(checkOracle({ ...base, oraclePrice: null }).multiplierCheck).toBe("UNCHECKED");
    expect(checkOracle({ ...base, isStockTokenCollateral: false, oraclePrice: expected }).multiplierCheck).toBe("NOT_APPLICABLE");
  });
});
