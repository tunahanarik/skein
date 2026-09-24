/**
 * Phase 4 policy decisions encoded in Phase 5 (P4-1 … P4-7).
 */
import { describe, expect, it } from "vitest";
import { RpcHealth } from "../../src/chain/health.js";
import { resolveRpcConfig, RpcConfigError } from "../../src/chain/rpcConfig.js";
import { ECOSYSTEM_VENUES } from "../../src/config/ecosystem.js";
import { classifyPriceImpact, TRADE_QUALITY_POLICY } from "../../src/config/tradeQuality.js";

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
