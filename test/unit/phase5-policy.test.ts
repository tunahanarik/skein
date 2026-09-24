/**
 * Phase 4 policy decisions encoded in Phase 5 (P4-1 … P4-7).
 */
import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { RpcHealth } from "../../src/chain/health.js";
import { classifyRpcError, isTransportFailure, ViemChainReader } from "../../src/chain/reader.js";
import { resolveRpcConfig, RpcConfigError } from "../../src/chain/rpcConfig.js";
import { ECOSYSTEM_VENUES } from "../../src/config/ecosystem.js";
import { classifyPriceImpact, TRADE_QUALITY_POLICY } from "../../src/config/tradeQuality.js";
import type { TradeQuote, TradeRoute } from "../../src/model/trade.js";
import { classifyQuotedRoute, classifyRoute } from "../../src/product/usability.js";

const E = 10n ** 18n;
const pct = (num: bigint, den = 1n) => (num * E) / (100n * den);

describe("P4-4 price-impact classes (Uniswap interface warning levels)", () => {
  it("boundaries are exact: <1% LOW, <5% ELEVATED, <15% HIGH, ≥15% EXTREME, null UNKNOWN", () => {
    expect(classifyPriceImpact(0n)).toBe("LOW");
    expect(classifyPriceImpact(pct(1n) - 1n)).toBe("LOW");
    expect(classifyPriceImpact(pct(1n))).toBe("ELEVATED");
    expect(classifyPriceImpact(pct(5n) - 1n)).toBe("ELEVATED");
    expect(classifyPriceImpact(pct(5n))).toBe("HIGH");
    expect(classifyPriceImpact(pct(15n) - 1n)).toBe("HIGH");
    expect(classifyPriceImpact(pct(15n))).toBe("EXTREME");
    expect(classifyPriceImpact(pct(60n))).toBe("EXTREME"); // the observed ~$83 pool
    expect(classifyPriceImpact(null)).toBe("UNKNOWN");
    expect(classifyPriceImpact(-5n)).toBe("LOW"); // rounding noise
  });
  it("policy is centralized, versioned and cites its source; route-liquidity line reuses LOW_LIQUIDITY", () => {
    expect(TRADE_QUALITY_POLICY.id).toBe("trade-quality-v1");
    expect(TRADE_QUALITY_POLICY.source).toMatch(/Uniswap\/interface/);
    expect(TRADE_QUALITY_POLICY.minActionableRouteTvlUsdE18).toBe(10_000n * E);
  });
});

describe("P4-6 production RPC semantics", () => {
  it("production without ROBINHOOD_RPC_URL fails clearly; the public RPC is refused", () => {
    expect(() => resolveRpcConfig({}, "production")).toThrow(RpcConfigError);
    expect(() => resolveRpcConfig({}, "production")).toThrow(/ROBINHOOD_RPC_URL/);
    expect(() => resolveRpcConfig({ ROBINHOOD_RPC_URL: "https://rpc.mainnet.chain.robinhood.com" }, "production")).toThrow(/public RPC/);
  });
  it("development falls back to the public RPC with log pacing; a keyed URL has none", () => {
    const dev = resolveRpcConfig({}, "development");
    expect(dev.isPublicRpc).toBe(true);
    expect(dev.logMinIntervalMs).toBe(1000);
    const keyed = resolveRpcConfig({ ROBINHOOD_RPC_URL: "https://example-provider.invalid/v2/KEY" }, "production");
    expect(keyed.isPublicRpc).toBe(false);
    expect(keyed.logMinIntervalMs).toBe(0);
  });
  it("optional separate index RPC is validated (https; never the public RPC in production)", () => {
    const c = resolveRpcConfig({ ROBINHOOD_RPC_URL: "https://a.invalid/k", ROBINHOOD_INDEX_RPC_URL: "https://b.invalid/k2" }, "production");
    expect(c.indexUrl).toBe("https://b.invalid/k2");
    expect(() => resolveRpcConfig({ ROBINHOOD_RPC_URL: "https://a.invalid/k", ROBINHOOD_INDEX_RPC_URL: "http://b.invalid" }, "production")).toThrow(/https/);
    expect(() => resolveRpcConfig({ ROBINHOOD_RPC_URL: "https://a.invalid/k", ROBINHOOD_INDEX_RPC_URL: "https://rpc.mainnet.chain.robinhood.com" }, "production")).toThrow(/public RPC/);
  });
  it("a keyed URL never appears in health output (reports, telemetry)", () => {
    const h = new RpcHealth("https://example-provider.invalid/v2/SECRETKEY?apikey=ALSOSECRET");
    expect(JSON.stringify(h.snapshot())).not.toMatch(/SECRET/);
  });
});

describe("P4-1 / P4-2 / P4-3 / P4-7 ecosystem metadata", () => {
  it("deferred and metadata-only venues are listed with decision and source, never as opportunities", () => {
    const ids = ECOSYSTEM_VENUES.map((v) => v.id);
    expect(ids).toEqual(expect.arrayContaining(["uniswap-v4", "ramses", "lighter", "rialto", "aggregators"]));
    expect(ECOSYSTEM_VENUES.find((v) => v.id === "lighter")).toMatchObject({ status: "METADATA_ONLY", decision: "P4-3" });
    expect(ECOSYSTEM_VENUES.every((v) => v.source.length > 0 && v.reason.length > 0)).toBe(true);
  });
});

describe("reader: transport failures folded into multicall results are retried (Phase 5 smoke fix)", () => {
  const cfg = { url: "http://x", isPublicRpc: true, multicallChunkSize: 10, maxAttempts: 3, timeoutMs: 1000, retryBaseMs: 1, logMinIntervalMs: 0 };
  const unknownRpc = Object.assign(new Error("An unknown RPC error occurred."), { name: "ContractFunctionExecutionError", cause: Object.assign(new Error("An unknown RPC error occurred."), { name: "UnknownRpcError" }) });
  const reverted = Object.assign(new Error('The contract function "balanceOf" reverted.'), { name: "ContractFunctionRevertedError" });
  const call = { address: "0x0000000000000000000000000000000000000001" as const, abi: [] as never, functionName: "x" };

  it("classifies the batch-parse crash as RATE_LIMITED and detects transport vs revert", () => {
    expect(classifyRpcError(new Error("Cannot read properties of undefined (reading 'error')"))).toBe("RATE_LIMITED");
    expect(isTransportFailure(unknownRpc)).toBe(true);
    expect(isTransportFailure(reverted)).toBe(false);
  });

  it("a chunk whose calls all carry a transport error is retried; a real revert is not", async () => {
    let n = 0;
    const client = { multicall: async () => (++n === 1 ? [{ status: "failure", error: unknownRpc }] : [{ status: "success", result: 7n }]) } as unknown as PublicClient;
    const r = await new ViemChainReader(cfg, client).multicall([call], { blockNumber: 1n });
    expect(n).toBe(2);
    expect(r[0]).toEqual({ status: "success", result: 7n });

    let m = 0;
    const client2 = { multicall: async () => (++m, [{ status: "failure", error: reverted }]) } as unknown as PublicClient;
    const r2 = await new ViemChainReader(cfg, client2).multicall([call], { blockNumber: 1n });
    expect(m).toBe(1);
    expect(r2[0]).toMatchObject({ status: "failure", kind: "REVERT" });
  });

  it("persisting transport failure ends as kind RPC (never mislabelled as a revert)", async () => {
    const client = { multicall: async () => [{ status: "failure", error: unknownRpc }] } as unknown as PublicClient;
    const r = await new ViemChainReader(cfg, client).multicall([call], { blockNumber: 1n });
    expect(r[0]).toMatchObject({ status: "failure", kind: "RPC" });
  });
});

describe("P4-4 thin routes never look normal", () => {
  const route = (tvlUsd: bigint | null) => ({ properties: { allMarketsVerified: true, allAssetsCanonical: true, bottleneckTvlUsd: tvlUsd === null ? null : { e18: tvlUsd * E } } }) as unknown as TradeRoute;
  const quote = (impactPct: bigint) => ({ priceImpact: pct(impactPct) / 10n }) as unknown as TradeQuote; // tenths of a percent
  it("an $83 route is LIMITED without an amount, still LIMITED at low impact, hidden at extreme impact", () => {
    expect(classifyRoute(route(83n))).toMatchObject({ status: "LIMITED", reasons: ["LOW_ROUTE_LIQUIDITY"] });
    expect(classifyQuotedRoute(route(83n), quote(1n), 100, 100)).toMatchObject({ status: "LIMITED", impactClass: "LOW" });
    expect(classifyQuotedRoute(route(83n), quote(600n), 100, 100)).toMatchObject({ status: "HIDDEN_BY_DEFAULT", impactClass: "EXTREME" });
    expect(classifyQuotedRoute(route(83n), quote(600n), 100, 100).reasons).toEqual(expect.arrayContaining(["EXTREME_PRICE_IMPACT", "LOW_ROUTE_LIQUIDITY"]));
  });
  it("a deep route at low impact is ACTIONABLE; unknown TVL is hidden; a stale quote is LIMITED", () => {
    expect(classifyQuotedRoute(route(1_000_000n), quote(1n), 100, 100).status).toBe("ACTIONABLE");
    expect(classifyRoute(route(null)).status).toBe("HIDDEN_BY_DEFAULT");
    expect(classifyQuotedRoute(route(1_000_000n), quote(1n), 1000, 100).reasons).toContain("QUOTE_STALE");
  });
});
