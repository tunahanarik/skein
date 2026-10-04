import { describe, expect, it } from "vitest";
import { RpcPriority } from "../src/priority.js";
import type { ChainReader } from "../src/reader.js";

/** A reader that records the order of its calls. */
function fakeReader(log: string[]): ChainReader {
  return {
    chainId: 4663,
    assertChainId: async () => undefined,
    getLatestBlock: async () => ({ number: 1n, hash: "0x01", timestamp: 1n }),
    getNativeBalance: async () => 0n,
    multicall: async () => {
      log.push("multicall");
      return [];
    },
    readContract: async () => null,
    getLogs: async () => [],
    health: () => ({}) as ReturnType<ChainReader["health"]>,
  } as ChainReader;
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe("RpcPriority", () => {
  it("with nothing held, background reads go straight through", async () => {
    const log: string[] = [];
    const bg = new RpcPriority().background(fakeReader(log));
    await bg.multicall([], { blockNumber: 1n });
    expect(log).toEqual(["multicall"]);
  });

  it("background reads wait while user-facing work is held, then go", async () => {
    const log: string[] = [];
    const p = new RpcPriority();
    const bg = p.background(fakeReader(log));
    let release!: () => void;
    const held = p.hold(() => new Promise<void>((r) => (release = r)).then(() => void log.push("user done")));
    const queued = bg.multicall([], { blockNumber: 1n });
    await tick();
    expect(log).toEqual([]); // still waiting for the user request
    release();
    await Promise.all([held, queued]);
    expect(log).toEqual(["user done", "multicall"]);
    expect(p.active).toBe(0);
  });

  it("the wait is bounded, so a background read inside a hold can never deadlock", async () => {
    const log: string[] = [];
    const p = new RpcPriority(20);
    const bg = p.background(fakeReader(log));
    await p.hold(async () => {
      await bg.multicall([], { blockNumber: 1n }); // issued from inside the hold
    });
    expect(log).toEqual(["multicall"]);
  });
});
