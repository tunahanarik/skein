import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseAbi, type PublicClient } from "viem";
import { RpcHealth, redactRpcUrl } from "../src/health.js";
import { classifyRpcError, MAX_LOG_RANGE, ViemChainReader } from "../src/reader.js";
import { resolveRpcConfig, RpcConfigError, runtimeMode, type RpcConfig } from "../src/rpcConfig.js";
import { TtlCache } from "@skein/core/lib/cache";
import { HttpClient, HttpError } from "@skein/core/lib/http";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });

describe("HttpClient", () => {
  const schema = z.object({ ok: z.boolean() });

  it("parses and validates JSON", async () => {
    const http = new HttpClient(async () => json({ ok: true }));
    await expect(http.getJson("https://x", schema)).resolves.toMatchObject({ data: { ok: true }, status: 200 });
  });

  it("rejects schema mismatches, non-JSON and oversize bodies", async () => {
    await expect(new HttpClient(async () => json({ ok: "yes" })).getJson("https://x", schema)).rejects.toMatchObject({ kind: "SCHEMA" });
    await expect(new HttpClient(async () => json("<html>")).getJson("https://x", schema)).rejects.toMatchObject({ kind: "BAD_JSON" });
    await expect(new HttpClient(async () => json({ ok: true, pad: "x".repeat(200) })).getJson("https://x", schema, { maxBytes: 50 })).rejects.toMatchObject({ kind: "TOO_LARGE" });
    await expect(new HttpClient(async () => json({ ok: true }, 200, { "content-length": "999999999" })).getJson("https://x", schema, { maxBytes: 50 })).rejects.toBeInstanceOf(HttpError);
  });

  it("retries 429/5xx, then succeeds; does not retry 404", async () => {
    let n = 0;
    const flaky = new HttpClient(async () => (++n < 3 ? json({}, 429) : json({ ok: true })));
    await expect(flaky.getJson("https://x", schema, { retries: 2 })).resolves.toBeTruthy();
    expect(n).toBe(3);
    let m = 0;
    const notFound = new HttpClient(async () => (m++, json({}, 404)));
    await expect(notFound.getJson("https://x", schema)).rejects.toMatchObject({ status: 404 });
    expect(m).toBe(1);
  });

  it("never sends credentials and refuses redirects", async () => {
    let init: RequestInit | undefined;
    await new HttpClient(async (_u, i) => ((init = i), json({ ok: true }))).getJson("https://x", schema);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
  });
});

describe("TtlCache", () => {
  it("coalesces concurrent loads and expires entries", async () => {
    let t = 0;
    const cache = new TtlCache<number>(() => t);
    let loads = 0;
    const load = async () => ++loads;
    const [a, b] = await Promise.all([cache.getOrLoad("k", 100, load), cache.getOrLoad("k", 100, load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    t = 101;
    expect(await cache.getOrLoad("k", 100, load)).toBe(2);
    expect(cache.getStale("k")?.value).toBe(2);
  });

  it("is bounded: past maxEntries the least recently stored entry goes, expired ones stay for getStale (SRV-3)", () => {
    let t = 0;
    const cache = new TtlCache<number>(() => t, { maxEntries: 3 });
    for (let i = 0; i < 10; i++) cache.set(`k${i}`, i, 1);
    expect(cache.size).toBe(3);
    expect(cache.getStale("k0")).toBeUndefined();
    t = 5; // all expired, still served stale
    expect(cache.getStale("k9")?.value).toBe(9);
    cache.set("k7", 70, 1); // re-storing moves a key to the end
    cache.set("k10", 10, 1);
    expect(cache.getStale("k7")?.value).toBe(70);
    expect(cache.getStale("k8")).toBeUndefined();
  });
});

describe("RPC configuration", () => {
  it("production refuses the public RPC; development allows it", () => {
    expect(() => resolveRpcConfig({}, "production")).toThrow(RpcConfigError);
    expect(resolveRpcConfig({}, "development")).toMatchObject({ isPublicRpc: true });
    expect(resolveRpcConfig({ ROBINHOOD_RPC_URL: "https://robinhood-mainnet.g.alchemy.com/v2/KEY" }, "production")).toMatchObject({ isPublicRpc: false });
  });

  it("requires https and validates numeric settings", () => {
    expect(() => resolveRpcConfig({ ROBINHOOD_RPC_URL: "http://rpc.example.com" }, "development")).toThrow(/https/);
    expect(() => resolveRpcConfig({ RPC_MULTICALL_CHUNK_SIZE: "0" }, "development")).toThrow(RpcConfigError);
    expect(resolveRpcConfig({ RPC_MULTICALL_CHUNK_SIZE: "50" }, "development").multicallChunkSize).toBe(50);
  });

  it("runtime mode fails closed: either variable can say production, unknown values refuse to start (A2)", () => {
    expect(runtimeMode({})).toBe("development");
    expect(runtimeMode({ NODE_ENV: "production" })).toBe("production");
    expect(runtimeMode({ APP_ENV: "development", NODE_ENV: "production" })).toBe("production");
    expect(runtimeMode({ APP_ENV: "prod" })).toBe("production");
    expect(runtimeMode({ APP_ENV: " Production " })).toBe("production");
    expect(() => runtimeMode({ APP_ENV: "staging" })).toThrow(RpcConfigError);
  });

  it("health output never contains the provider key in the URL path", () => {
    expect(redactRpcUrl("https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY")).toBe("https://robinhood-mainnet.g.alchemy.com/…");
    expect(redactRpcUrl("https://rpc.mainnet.chain.robinhood.com")).toBe("https://rpc.mainnet.chain.robinhood.com");
  });
});

describe("RPC error classification and health", () => {
  it("classifies rate limits, timeouts and other errors", () => {
    expect(classifyRpcError({ status: 429 })).toBe("RATE_LIMITED");
    expect(classifyRpcError(new Error("HTTP request failed. Status: 429 Too Many Requests"))).toBe("RATE_LIMITED");
    expect(classifyRpcError({ name: "TimeoutError", message: "The request took too long" })).toBe("TIMEOUT");
    expect(classifyRpcError(new Error("execution reverted"))).toBe("ERROR");
  });

  it("tracks outcomes, latency and status", () => {
    const h = new RpcHealth("https://x.example");
    expect(h.snapshot().status).toBe("UNKNOWN");
    h.record("SUCCESS", 10);
    h.record("SUCCESS", 30);
    expect(h.snapshot()).toMatchObject({ status: "HEALTHY", avgLatencyMs: 20, requests: 2 });
    h.record("RATE_LIMITED", 5, "429");
    expect(h.snapshot()).toMatchObject({ status: "DEGRADED", rateLimited: 1, lastError: "429" });
    h.record("TIMEOUT", 5);
    h.record("ERROR", 5);
    expect(h.snapshot().status).toBe("DOWN");
    h.observeBlock(5n);
    h.observeBlock(3n);
    expect(h.snapshot().latestBlock).toBe("5");
  });
});

describe("ViemChainReader.multicall chunking and partial failure", () => {
  const cfg: RpcConfig = { url: "https://x.example", isPublicRpc: false, multicallChunkSize: 2, maxAttempts: 2, timeoutMs: 1_000, retryBaseMs: 0 };
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  const call = (i: number) => ({ address: `0x${i.toString(16).padStart(40, "0")}` as const, abi, functionName: "balanceOf", args: ["0x0000000000000000000000000000000000000001"] });

  it("preserves order across chunks; a failed chunk marks only its calls as RPC failures", async () => {
    let chunk = 0;
    const client = {
      multicall: async ({ contracts }: { contracts: unknown[] }) => {
        chunk++;
        if (chunk === 2 || chunk === 3) throw new Error("HTTP 429 Too Many Requests"); // chunk #2 fails both attempts
        return contracts.map((_, i) => (i === 1 && chunk === 1 ? { status: "failure", error: new Error("execution reverted") } : { status: "success", result: BigInt(chunk * 10 + i) }));
      },
    } as unknown as PublicClient;
    const reader = new ViemChainReader(cfg, client);
    const res = await reader.multicall([call(1), call(2), call(3), call(4), call(5)], { blockNumber: 1n });
    expect(res.map((r) => r.status)).toEqual(["success", "failure", "failure", "failure", "success"]);
    expect(res[1]).toMatchObject({ kind: "REVERT" });
    expect(res[2]).toMatchObject({ kind: "RPC" });
    expect(res[4]).toMatchObject({ status: "success", result: 40n }); // 4th invocation, index 0
    expect(reader.health()).toMatchObject({ rateLimited: 2, retries: 1, status: "DEGRADED" });
  });

  it("retries a transient chunk failure and succeeds", async () => {
    let n = 0;
    const client = {
      multicall: async ({ contracts }: { contracts: unknown[] }) => {
        if (n++ === 0) throw new Error("timeout");
        return contracts.map(() => ({ status: "success", result: 1n }));
      },
    } as unknown as PublicClient;
    const reader = new ViemChainReader(cfg, client);
    const res = await reader.multicall([call(1)], { blockNumber: 1n });
    expect(res[0]).toMatchObject({ status: "success" });
    expect(reader.health()).toMatchObject({ timeouts: 1, retries: 1 });
  });

  it("rejects an endpoint on the wrong chain", async () => {
    const reader = new ViemChainReader(cfg, { getChainId: async () => 1 } as unknown as PublicClient);
    await expect(reader.assertChainId()).rejects.toThrow(/expected 4663/);
  });
});

describe("ViemChainReader.getLogs range splitting", () => {
  const cfg: RpcConfig = { url: "https://x.example", isPublicRpc: false, multicallChunkSize: 2, maxAttempts: 1, timeoutMs: 1_000, retryBaseMs: 0 };
  const event = parseAbi(["event Created(address indexed market)"])[0];

  it("splits a span wider than MAX_LOG_RANGE up front, so the RPC never sees an oversized query", async () => {
    const spans: [bigint, bigint][] = [];
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        spans.push([fromBlock, toBlock]);
        return [{ address: "0x0000000000000000000000000000000000000001", blockNumber: fromBlock, transactionHash: "0x01", logIndex: 0, args: {} }];
      },
    } as unknown as PublicClient;
    const reader = new ViemChainReader(cfg, client);
    const logs = await reader.getLogs({ address: "0x0000000000000000000000000000000000000001", event, fromBlock: 1n, toBlock: MAX_LOG_RANGE * 2n + 10n });
    expect(spans).toEqual([
      [1n, MAX_LOG_RANGE],
      [MAX_LOG_RANGE + 1n, MAX_LOG_RANGE * 2n],
      [MAX_LOG_RANGE * 2n + 1n, MAX_LOG_RANGE * 2n + 10n],
    ]);
    expect(logs.map((l) => l.blockNumber)).toEqual([1n, MAX_LOG_RANGE + 1n, MAX_LOG_RANGE * 2n + 1n]);
    expect(reader.health()).toMatchObject({ failures: 0 });
  });
});
