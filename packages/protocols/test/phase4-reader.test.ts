/**
 * Phase 4 ChainReader fixes, found against the live RPC:
 *  - the provider's reason lives in viem's `details` / `cause`, not the first message line;
 *  - "log query timed out" is a range error (bisect), not a transient one;
 *  - a hard sub-request budget stops runaway bisection;
 *  - wrapped errors keep their cause.
 */
import { describe, expect, it } from "vitest";
import type { PublicClient } from "viem";
import { classifyRpcError, isLogRangeError, MAX_LOG_SUBREQUESTS, RpcRequestError, ViemChainReader } from "@skein/chain/reader";
import { poolCreatedEvent } from "../src/uniswap/constants.js";

const cfg = { url: "http://x", isPublicRpc: true, multicallChunkSize: 10, maxAttempts: 2, timeoutMs: 1000, retryBaseMs: 1 };
const viemLike = (details: string) => Object.assign(new Error("An unknown RPC error occurred.\n\nDetails: " + details), { name: "UnknownRpcError", details });

describe("error classification uses the full error chain", () => {
  it("429 carried only in details or in a cause is RATE_LIMITED", () => {
    expect(classifyRpcError(viemLike("Too Many Requests"))).toBe("RATE_LIMITED");
    expect(classifyRpcError(new RpcRequestError("eth_getLogs failed: An unknown RPC error occurred.", "ERROR", viemLike("Too Many Requests")))).toBe("RATE_LIMITED");
    expect(classifyRpcError(Object.assign(new Error("x"), { cause: { status: 429 } }))).toBe("RATE_LIMITED");
  });
  it("range errors are recognised through wrappers; unrelated errors are not", () => {
    expect(isLogRangeError(new RpcRequestError("eth_getLogs failed: Missing or invalid parameters.", "ERROR", viemLike("logs matched by query exceeds limit of 10000")))).toBe(true);
    expect(isLogRangeError(viemLike("log query timed out"))).toBe(true);
    expect(isLogRangeError(viemLike("execution reverted"))).toBe(false);
  });
});

describe("getLogs", () => {
  it("a 'log query timed out' range is bisected until it answers", async () => {
    const calls: bigint[] = [];
    const client = {
      getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
        calls.push(toBlock - fromBlock);
        if (toBlock - fromBlock > 100n) throw viemLike("log query timed out");
        return [];
      },
    } as unknown as PublicClient;
    await new ViemChainReader(cfg, client).getLogs({ address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", event: poolCreatedEvent, fromBlock: 0n, toBlock: 1000n });
    expect(calls.length).toBeGreaterThan(8);
  });
  it("runaway bisection stops at the sub-request budget and throws (never a partial list)", async () => {
    let n = 0;
    const client = {
      getLogs: async () => {
        n++;
        throw viemLike("log query timed out");
      },
    } as unknown as PublicClient;
    await expect(new ViemChainReader(cfg, client).getLogs({ address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", event: poolCreatedEvent, fromBlock: 0n, toBlock: 10n ** 12n })).rejects.toThrow();
    expect(n).toBeLessThanOrEqual(MAX_LOG_SUBREQUESTS);
  });
  it("topic filters are passed through to the provider", async () => {
    let seen: unknown;
    const client = {
      getLogs: async (p: { args?: unknown }) => {
        seen = p.args;
        return [];
      },
    } as unknown as PublicClient;
    await new ViemChainReader(cfg, client).getLogs({ address: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", event: poolCreatedEvent, fromBlock: 0n, toBlock: 1n, args: { token0: ["0x0000000000000000000000000000000000000001"] } });
    expect(seen).toEqual({ token0: ["0x0000000000000000000000000000000000000001"] });
  });
});

describe("FilePoolListStore", () => {
  it("round-trips an in-progress cold scan (scannedTo -1, pending tasks, nullable creation block)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FilePoolListStore } = await import("../src/uniswap/poolStore.js");
    const path = join(mkdtempSync(join(tmpdir(), "pools-")), "p.json");
    const st = new FilePoolListStore(path);
    const snap = {
      version: 1 as const, chainId: 4663, factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa", tokenSetHash: "abc", scannedTo: -1n, savedAt: 1,
      pools: [{ pool: "0x000000000000000000000000000000000000c001" as const, token0: "0x000000000000000000000000000000000000a001" as const, token1: "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as const, fee: 500, tickSpacing: 10, createdAtBlock: 5n, via: "EVENT" as const }],
      coldScan: { target: 100n, pending: ["token0:0:10"] },
    };
    st.save(snap);
    const back = st.load()!;
    expect(back.scannedTo).toBe(-1n);
    expect(back.coldScan).toEqual({ target: 100n, pending: ["token0:0:10"] });
    expect(back.pools[0]!.createdAtBlock).toBe(5n);
  });
  it("a malformed file is ignored (full rescan), never partially trusted", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FilePoolListStore } = await import("../src/uniswap/poolStore.js");
    const path = join(mkdtempSync(join(tmpdir(), "pools-")), "p.json");
    writeFileSync(path, JSON.stringify({ version: 1, pools: [{ pool: "not-an-address" }] }));
    expect(new FilePoolListStore(path).load()).toBeNull();
  });
});
