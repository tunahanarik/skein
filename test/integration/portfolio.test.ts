/** Portfolio Engine end-to-end on the offline fixture world (fake chain + fixture APIs). */
import { describe, expect, it } from "vitest";
import { getPortfolio, portfolioToJson } from "@skein/portfolio/engine";
import { ValidationError } from "@skein/core/lib/validation";
import {
  AAPL,
  defaultWorld,
  FEED_ETH,
  NOFEED,
  NOW_S,
  NVDA,
  ONE,
  REVERTS,
  RHJ_ASSETS,
  rhjAsset,
  SPLT,
  testStack,
  UNKNOWN_FAKE_USDG,
  USDG,
  WALLET,
  WETH,
} from "@skein/testkit/world";

async function run(opts: Parameters<typeof testStack>[0] = {}, p: Parameters<typeof getPortfolio>[2] = {}) {
  const s = await testStack(opts);
  const portfolio = await getPortfolio(WALLET.toLowerCase(), s.deps, p);
  const row = (addr: string | null) => portfolio.assets.find((a) => (addr === null ? a.asset.address === null : a.asset.address === addr));
  return { portfolio, row, s };
}

describe("Portfolio Engine", () => {
  it("normalizes the wallet, fixes chainId 4663 and pins one block", async () => {
    const { portfolio } = await run();
    expect(portfolio.chainId).toBe(4663);
    expect(portfolio.walletAddress).toBe(WALLET); // checksummed from lowercase input
    expect(portfolio.blockNumber).toBe(71_000_000n);
  });

  it("rejects invalid wallet input before any network access", async () => {
    const s = await testStack();
    for (const bad of ["0x123", "not-an-address", 42, "0x0000000000000000000000000000000000000000", "0x1111111111111111111111111111111111111111".replace(/1$/, "G")]) {
      await expect(getPortfolio(bad, s.deps)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(s.reader.calls).toBe(0);
  });

  it("ETH (native) and WETH (ERC-20) are separate rows, both valued at ETH/USD", async () => {
    const { row } = await run();
    const eth = row(null)!;
    const weth = row(WETH)!;
    expect(eth.asset.type).toBe("NATIVE");
    expect(weth.asset.type).toBe("WRAPPED_NATIVE");
    expect(eth).toMatchObject({ rawBalance: 5n * 10n ** 16n, displayBalance: "0.05", valueUsd: "133.963425" });
    expect(weth).toMatchObject({ rawBalance: 10n ** 17n, displayBalance: "0.1", valueUsd: "267.92685" });
    expect(eth.price?.source?.contract).toBe(FEED_ETH);
  });

  it("USDG: 6-decimal normalization and feed valuation (not $1)", async () => {
    const r = (await run()).row(USDG)!;
    expect(r.displayBalance).toBe("1234.56");
    expect(r.valueUsd).toBe("1234.6711104"); // 1234.56 × 1.00009
    expect(r.price?.pegDeviationBps).toBeCloseTo(0.9, 9);
  });

  it("Stock Token with multiplier ≠ 1: display shares from the onchain multiplier, value from the token feed", async () => {
    const r = (await run()).row(NVDA)!;
    expect(r.rawBalance).toBe(2n * ONE);
    expect(r.displayBalance).toBe("2");
    expect(r.stock).toMatchObject({ uiMultiplier: "1.000775159164630595", multiplierSource: "ONCHAIN", displayShareBalance: "2.00155031832926119" });
    // 2 × 224.41382169 — the feed already contains the multiplier; NOT 2 × 224.41 × 1.000775
    expect(r.valueUsd).toBe("448.82764338");
    expect(r.price?.method).toBe("CHAINLINK_STOCK_TOKEN_FEED");
  });

  it("Stock Token after a 4:1 split priced by fallback: raw × (mid × 4), multiplier applied once", async () => {
    const r = (await run()).row(SPLT)!;
    expect(r.stock?.displayShareBalance).toBe("12"); // 3 tokens × 4.0
    expect(r.valueUsd).toBe("300.6"); // 3 × (25.05 × 4)
  });

  it("zero balances are hidden by default and returned with includeZeroBalances", async () => {
    expect((await run()).row(AAPL)).toBeUndefined();
    const withZero = (await run({}, { includeZeroBalances: true })).row(AAPL)!;
    expect(withZero).toMatchObject({ rawBalance: 0n, displayBalance: "0", pricingStatus: "UNPRICED", price: null });
  });

  it("an unpriceable asset is UNPRICED and makes coverage PARTIAL — never counted as $0", async () => {
    const { portfolio, row } = await run();
    expect(row(NOFEED)).toMatchObject({ pricingStatus: "UNPRICED", valueUsd: null });
    expect(row(NOFEED)!.warnings.map((w) => w.code)).toContain("UNPRICED_ASSET");
    expect(portfolio.valuationCoverage).toMatchObject({ coverageStatus: "PARTIAL", totalValueUsd: null });
    expect(portfolio.totals.unpricedAssetCount).toBe(1);
  });

  it("a reverting balanceOf fails that asset only (BALANCE_READ_FAILED), not the portfolio", async () => {
    const { portfolio, row } = await run();
    expect(row(REVERTS)).toMatchObject({ balanceStatus: "FAILED", rawBalance: null, displayBalance: null });
    expect(row(REVERTS)!.warnings[0]?.code).toBe("BALANCE_READ_FAILED");
    expect(portfolio.totals.failedBalanceCount).toBe(1);
    expect(row(NVDA)?.pricingStatus).toBe("PRICED");
  });

  it("totals sum priced assets exactly and coverage is COMPLETE only when everything held is priced", async () => {
    const world = defaultWorld();
    world.balances.get(NOFEED.toLowerCase())!.set(WALLET.toLowerCase(), 0n);
    world.revertBalanceOf.clear();
    const { portfolio } = await run({ world });
    // 133.963425 + 267.92685 + 1234.6711104 + 448.82764338 + 300.6
    expect(portfolio.totals.pricedValueUsd).toBe("2385.98902878");
    expect(portfolio.valuationCoverage).toMatchObject({ coverageStatus: "COMPLETE", totalValueUsd: "2385.98902878", pricedAssets: 5, unpricedAssets: 0 });
  });

  it("RPC down: every read fails, coverage UNKNOWN, no fabricated values", async () => {
    const world = defaultWorld();
    world.rpcDown = true;
    const { portfolio } = await run({ world });
    expect(portfolio.valuationCoverage.coverageStatus).toBe("UNKNOWN");
    expect(portfolio.totals.pricedValueUsd).toBe("0");
    expect(portfolio.assets.every((a) => a.balanceStatus === "FAILED")).toBe(true);
    expect(portfolio.warnings.map((w) => w.code)).toContain("RPC_DEGRADED");
  });

  it("multiplier unreadable: falls back to the live registry value with a warning", async () => {
    const world = defaultWorld();
    world.multipliers.set(NVDA.toLowerCase(), "revert");
    const r = (await run({ world })).row(NVDA)!;
    expect(r.stock?.multiplierSource).toBe("REGISTRY");
    expect(r.warnings.map((w) => w.code)).toContain("MULTIPLIER_FROM_REGISTRY");
  });

  it("multiplier unreadable and registry only from snapshot: MULTIPLIER_UNAVAILABLE, no display shares, feed value still valid", async () => {
    const world = defaultWorld();
    world.multipliers.set(NVDA.toLowerCase(), "revert");
    const r = (await run({ world, liveFails: true })).row(NVDA)!;
    expect(r.stock).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain("MULTIPLIER_UNAVAILABLE");
    expect(r.valueUsd).toBe("448.82764338"); // token feed needs no multiplier
  });

  it("onchain multiplier differing from the registry is used and reported", async () => {
    const world = defaultWorld();
    world.multipliers.set(NVDA.toLowerCase(), 2n * ONE);
    const r = (await run({ world })).row(NVDA)!;
    expect(r.stock?.uiMultiplier).toBe("2");
    expect(r.warnings.map((w) => w.code)).toContain("REGISTRY_MULTIPLIER_MISMATCH");
  });

  it("pending multiplier from the registry becomes effective only after its time", async () => {
    const pending = RHJ_ASSETS.map((a) =>
      a.tokenSymbol === "SPLT" ? rhjAsset("SPLT", SPLT, 3, "4", { pendingMultiplier: "8", pendingMultiplierEffectiveTime: new Date((NOW_S - 60) * 1000).toISOString() }) : a,
    );
    const world = defaultWorld();
    world.multipliers.set(SPLT.toLowerCase(), "revert");
    const r = (await run({ world, assets: pending })).row(SPLT)!;
    expect(r.stock?.uiMultiplier).toBe("8");
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["PENDING_MULTIPLIER", "MULTIPLIER_FROM_REGISTRY"]));
  });

  it("an explicitly supplied unknown token is UNKNOWN, unpriced, and flagged as a USDG look-alike", async () => {
    const { row, portfolio } = await run({}, { extraTokens: [UNKNOWN_FAKE_USDG] });
    const r = row(UNKNOWN_FAKE_USDG)!;
    expect(r.asset).toMatchObject({ type: "UNKNOWN", canonical: false, symbol: "USDG" });
    expect(r).toMatchObject({ displayBalance: "5", pricingStatus: "UNPRICED", verificationStatus: "UNVERIFIED" });
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["UNKNOWN_ASSET", "LOOKALIKE_TOKEN"]));
    expect(portfolio.valuationCoverage.coverageStatus).toBe("PARTIAL");
  });

  it("registry snapshot mode is visible in the portfolio", async () => {
    const { portfolio } = await run({ liveFails: true });
    expect(portfolio.registry.mode).toBe("SNAPSHOT");
    expect(portfolio.warnings.map((w) => w.code)).toContain("REGISTRY_SNAPSHOT_MODE");
  });

  it("registry identity conflict: the token is not scanned and REGISTRY_CONFLICT is raised", async () => {
    const moved = "0x00000000000000000000000000000000000000D1";
    const { portfolio } = await run({ assets: RHJ_ASSETS.map((a) => (a.tokenSymbol === "NVDA" ? rhjAsset("NVDA", moved as never, 1, a.currentMultiplier) : a)) });
    expect(portfolio.assets.find((a) => a.asset.symbol === "NVDA")).toBeUndefined();
    expect(portfolio.warnings.map((w) => w.code)).toContain("REGISTRY_CONFLICT");
  });

  it("uses one multicall for all ERC-20 balances + multipliers (no N+1)", async () => {
    const { s } = await run();
    // balances (1) + feed rounds (1); the native balance is a separate eth_getBalance
    expect(s.reader.multicallInvocations).toBe(2);
  });

  it("large and tiny balances keep full precision; JSON output serializes bigints", async () => {
    const world = defaultWorld();
    world.balances.get(NVDA.toLowerCase())!.set(WALLET.toLowerCase(), 123_456_789_012_345_678_901_234_567n); // 123,456,789 tokens
    world.balances.get(SPLT.toLowerCase())!.set(WALLET.toLowerCase(), 1n); // 1 wei
    const { row, portfolio } = await run({ world });
    expect(row(NVDA)!.displayBalance).toBe("123456789.012345678901234567");
    expect(row(NVDA)!.valueUsd).toBe("27705409835.836494393583649239"); // exact (Decimal check): raw × 224.41382169 / 1e18, floored
    expect(row(SPLT)).toMatchObject({ displayBalance: "0.000000000000000001", valueUsd: "0.0000000000000001" });
    expect(row(SPLT)!.stock?.displayShareBalance).toBe("0.000000000000000004");
    const parsed = JSON.parse(portfolioToJson(portfolio));
    expect(typeof parsed.blockNumber).toBe("string");
  });

  it("rounding: values are floored once at 1e-18 USD, never rounded up", async () => {
    const world = defaultWorld();
    world.balances.get(USDG.toLowerCase())!.set(WALLET.toLowerCase(), 1n); // 0.000001 USDG at 1.00009
    const { row } = await run({ world });
    expect(row(USDG)!.valueUsd).toBe("0.00000100009");
  });
});
