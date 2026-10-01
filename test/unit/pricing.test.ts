import { describe, expect, it } from "vitest";
import { classifyFreshness } from "../../src/config/freshness.js";
import type { PriceRequest } from "../../src/pricing/priceService.js";
import { BLOCK, DEFAULT_QUOTES, defaultWorld, FEED_ETH, FEED_NVDA, FEED_USDG, NOW_S, NVDA, NVDA_MULT, ONE, quote, SPLT, testStack, USDG, WETH } from "../fixtures/world.js";

type Stack = Awaited<ReturnType<typeof testStack>>;
const src = { type: "ONCHAIN" as const, provider: "test", observedAt: "2026-09-24T12:00:00.000Z" };

async function price(stack: Stack, address: `0x${string}` | null, multiplier?: bigint | null) {
  const asset = stack.registry.get(4663, address)!;
  const req: PriceRequest = { asset, multiplier: multiplier ? { valueE18: multiplier, source: "ONCHAIN", provenance: src } : null };
  const batch = await stack.prices.priceAssets([req], { blockNumber: BLOCK.number });
  return { q: batch.quotes.get(asset.key)!, batch };
}

describe("freshness policy", () => {
  it("classifies against per-source thresholds, including heartbeat-relative ones", () => {
    expect(classifyFreshness("CHAINLINK_STOCK_FEED", NOW_S - 3_600, NOW_S, 86_400).status).toBe("FRESH");
    expect(classifyFreshness("CHAINLINK_STOCK_FEED", NOW_S - 3_601, NOW_S, 86_400).status).toBe("AGING");
    expect(classifyFreshness("CHAINLINK_STOCK_FEED", NOW_S - 86_400, NOW_S, 86_400).status).toBe("AGING");
    expect(classifyFreshness("CHAINLINK_STOCK_FEED", NOW_S - 86_401, NOW_S, 86_400).status).toBe("STALE");
    expect(classifyFreshness("CHAINLINK_USDG_USD", NOW_S - 86_400, NOW_S, 86_400).status).toBe("FRESH");
    expect(classifyFreshness("CHAINLINK_USDG_USD", NOW_S - 86_400 - 3_600, NOW_S, 86_400).status).toBe("AGING");
    expect(classifyFreshness("ROBINHOOD_QUOTE", NOW_S - 61, NOW_S).status).toBe("AGING");
    expect(classifyFreshness("ROBINHOOD_QUOTE", NOW_S - 901, NOW_S).status).toBe("STALE");
  });

  it("unknown, zero and future timestamps are UNKNOWN; a heartbeat rule without a heartbeat is UNKNOWN", () => {
    expect(classifyFreshness("ROBINHOOD_QUOTE", null, NOW_S).status).toBe("UNKNOWN");
    expect(classifyFreshness("ROBINHOOD_QUOTE", 0, NOW_S).status).toBe("UNKNOWN");
    expect(classifyFreshness("ROBINHOOD_QUOTE", NOW_S + 3_600, NOW_S).status).toBe("UNKNOWN");
    expect(classifyFreshness("ROBINHOOD_QUOTE", NOW_S + 30, NOW_S).status).toBe("FRESH"); // within skew tolerance
    expect(classifyFreshness("CHAINLINK_STOCK_FEED", NOW_S - 10, NOW_S, null).status).toBe("UNKNOWN");
  });
});

describe("Stock Token pricing", () => {
  it("prefers a fresh Chainlink feed and cross-checks it against the Robinhood quote", async () => {
    const { q } = await price(await testStack(), NVDA, NVDA_MULT);
    expect(q).toMatchObject({ status: "PRICED", method: "CHAINLINK_STOCK_TOKEN_FEED", priceUsdDisplay: "224.41382169", freshnessStatus: "FRESH", confidence: "HIGH" });
    expect(q.crossCheck).toMatchObject({ performed: true, conflict: false });
    expect(q.crossCheck!.percentageDifference!).toBeLessThan(0.05);
    // bid/ask kept, spread computed on the underlying quote
    expect(q.robinhoodQuote).toMatchObject({ bid: "224.20", ask: "224.22", spreadAbsolute: "0.02" });
    expect(q.robinhoodQuote!.spreadBps).toBeCloseTo((0.02 / 224.21) * 10_000, 5); // 1e-6 bps resolution
  });

  it("falls back to Robinhood mid × multiplier when there is no feed — applying the multiplier exactly once", async () => {
    const { q } = await price(await testStack(), SPLT, 4n * ONE);
    // underlying mid 25.05 × 4.0 = 100.20 USD per token
    expect(q).toMatchObject({ status: "PRICED", method: "ROBINHOOD_QUOTE_MID", priceUsdDisplay: "100.2", confidence: "MEDIUM", verificationStatus: "VERIFIED_OFFICIAL_API" });
    expect(q.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["NO_CHAINLINK_FEED", "PRICE_FALLBACK_USED"]));
  });

  it("a stale Chainlink round is not used as current; the quote fallback is used and both facts are surfaced", async () => {
    const world = defaultWorld();
    world.rounds.set(FEED_NVDA.toLowerCase(), { answer: 20_000_000_000n, updatedAt: NOW_S - 90_000 });
    const { q } = await price(await testStack({ world }), NVDA, NVDA_MULT);
    expect(q.method).toBe("ROBINHOOD_QUOTE_MID");
    expect(q.chainlink?.freshness).toBe("STALE");
    expect(q.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["STALE_PRICE", "PRICE_FALLBACK_USED"]));
    // 224.21 × 1.000775159164630595
    expect(Number(q.priceUsdDisplay)).toBeCloseTo(224.21 * 1.000775159164630595, 9);
  });

  it("stale feed and no usable quote → UNPRICED (never the stale value)", async () => {
    const world = defaultWorld();
    world.rounds.set(FEED_NVDA.toLowerCase(), { answer: 20_000_000_000n, updatedAt: NOW_S - 90_000 });
    const { q } = await price(await testStack({ world, quotes: "fail" }), NVDA, NVDA_MULT);
    expect(q).toMatchObject({ status: "UNPRICED", priceUsd: null });
    expect(q.unpricedReason).toMatch(/feed STALE.*no Robinhood quote/);
  });

  it("flags PRICE_CONFLICT above the threshold but keeps the Chainlink price, with LOW confidence", async () => {
    // quote as if the feed EXCLUDED the multiplier… but here we make the quote 3% off
    const quotes = [quote("NVDA", NVDA, "217.50", "217.52"), ...DEFAULT_QUOTES.slice(1)];
    const { q } = await price(await testStack({ quotes }), NVDA, NVDA_MULT);
    expect(q.method).toBe("CHAINLINK_STOCK_TOKEN_FEED");
    expect(q.crossCheck).toMatchObject({ performed: true, conflict: true, thresholdPct: 1 });
    expect(q.confidence).toBe("LOW");
    expect(q.warnings.find((w) => w.code === "PRICE_CONFLICT")?.details?.multiplierE18).toBe(NVDA_MULT.toString());
  });

  it("a halted quote is never used as a fallback", async () => {
    const quotes = [quote("SPLT", SPLT, "25.00", "25.10", { isTradingHalt: true })];
    const { q } = await price(await testStack({ quotes }), SPLT, 4n * ONE);
    expect(q.status).toBe("UNPRICED");
    expect(q.warnings.map((w) => w.code)).toContain("TRADING_HALTED");
  });

  it("an aging quote gives LOW confidence; a stale quote is not used", async () => {
    const aging = [quote("SPLT", SPLT, "25", "25.1", { generatedAt: new Date((NOW_S - 300) * 1000).toISOString() })];
    expect((await price(await testStack({ quotes: aging }), SPLT, 4n * ONE)).q.confidence).toBe("LOW");
    const stale = [quote("SPLT", SPLT, "25", "25.1", { generatedAt: new Date((NOW_S - 3_000) * 1000).toISOString() })];
    expect((await price(await testStack({ quotes: stale }), SPLT, 4n * ONE)).q.status).toBe("UNPRICED");
  });

  it("without a multiplier the quote cannot be converted to a token price", async () => {
    const { q } = await price(await testStack(), SPLT, null);
    expect(q.status).toBe("UNPRICED");
    expect(q.unpricedReason).toMatch(/no multiplier/);
  });

  it("rejects invalid rounds (non-positive answer, answeredInRound < roundId)", async () => {
    const world = defaultWorld();
    world.rounds.set(FEED_NVDA.toLowerCase(), { answer: 0n, updatedAt: NOW_S });
    let r = await price(await testStack({ world }), NVDA, NVDA_MULT);
    expect(r.q.chainlink).toMatchObject({ valid: false, invalidReason: "non-positive answer" });
    expect(r.q.method).toBe("ROBINHOOD_QUOTE_MID");
    world.rounds.set(FEED_NVDA.toLowerCase(), { answer: 22_441_382_169n, updatedAt: NOW_S, roundId: 5n, answeredInRound: 4n });
    r = await price(await testStack({ world }), NVDA, NVDA_MULT);
    expect(r.q.warnings.map((w) => w.code)).toContain("INVALID_FEED_ROUND");
  });

  it("directory outage degrades to quotes with a batch warning", async () => {
    const { q, batch } = await price(await testStack({ feeds: "fail" }), NVDA, NVDA_MULT);
    expect(batch.warnings.map((w) => w.code)).toContain("FEED_DIRECTORY_UNAVAILABLE");
    expect(q.method).toBe("ROBINHOOD_QUOTE_MID");
  });
});

describe("ETH, WETH and USDG pricing", () => {
  it("ETH and WETH both use ETH/USD and are separate assets", async () => {
    const stack = await testStack();
    const eth = (await price(stack, null)).q;
    const weth = (await price(stack, WETH)).q;
    expect(eth.assetKey).toBe("4663:native");
    expect(weth.assetKey).toBe(`4663:${WETH.toLowerCase()}`);
    expect(eth.priceUsdDisplay).toBe("2679.2685");
    expect(weth.priceUsdDisplay).toBe("2679.2685");
    expect(eth.source?.contract).toBe(FEED_ETH);
  });

  it("USDG uses its own feed and exposes the peg deviation", async () => {
    const { q } = await price(await testStack(), USDG);
    expect(q).toMatchObject({ method: "CHAINLINK_USDG_USD", priceUsdDisplay: "1.00009", confidence: "HIGH" });
    expect(q.pegDeviationBps).toBeCloseTo(0.9, 9);
  });

  it("USDG off-peg by more than 50 bps is flagged", async () => {
    const world = defaultWorld();
    world.rounds.set(FEED_USDG.toLowerCase(), { answer: 99_200_000n, updatedAt: NOW_S - 60 });
    const { q } = await price(await testStack({ world }), USDG);
    expect(q.pegDeviationBps).toBeCloseTo(-80, 9);
    expect(q.warnings.map((w) => w.code)).toContain("USDG_PEG_DEVIATION");
    expect(q.confidence).toBe("MEDIUM");
  });

  it("USDG with a stale feed is UNPRICED — never an assumed $1", async () => {
    const world = defaultWorld();
    world.rounds.set(FEED_USDG.toLowerCase(), { answer: 100_000_000n, updatedAt: NOW_S - 100_000 });
    const { q } = await price(await testStack({ world }), USDG);
    expect(q.status).toBe("UNPRICED");
    expect(q.unpricedReason).toMatch(/no assumed-peg fallback/);
  });
});

describe("crypto tokens priced by their own Chainlink USD feed", () => {
  const LINK = "0x492641F648a4986844848E0beFE66D14817bCE34" as const;
  const FEED_LINK = "0x000000000000000000000000000000000000f00a" as const;
  const linkFeed = { name: "LINK / USD", path: "link / usd", proxyAddress: FEED_LINK, decimals: 8, heartbeat: 86_400, threshold: 0.5 };

  it("prices LINK from the feed named in the registry, never from another feed", async () => {
    const world = defaultWorld();
    world.rounds.set(FEED_LINK.toLowerCase(), { answer: 1_436_505_647n, updatedAt: NOW_S - 120 });
    const { FEEDS } = await import("../fixtures/world.js");
    const { q } = await price(await testStack({ world, feeds: [...FEEDS, linkFeed as never] }), LINK);
    expect(q).toMatchObject({ status: "PRICED", method: "CHAINLINK_USD_FEED", priceUsdDisplay: "14.36505647", freshnessStatus: "FRESH" });
  });

  it("is UNPRICED (not $0, not ETH/USD) when its feed is missing from the directory", async () => {
    const { q, batch } = await price(await testStack(), LINK);
    expect(q).toMatchObject({ status: "UNPRICED", priceUsd: null });
    expect(q.unpricedReason).toMatch(/LINK \/ USD feed not found/);
    expect([...q.warnings, ...batch.warnings].map((w) => w.code)).toContain("UNPRICED_ASSET");
  });
});
