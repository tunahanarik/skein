/**
 * User-facing work first on a shared, rate-limited RPC.
 *
 * The periodic opportunity snapshot sends hundreds of calls; on the public RPC a wallet view
 * that starts during a refresh queued behind them (8 to 9 s instead of about 1.4 s, measured
 * 2026-10-04). Background code reads through `background(reader)`; a user request wraps its work
 * in `hold()`, and while any hold is active background calls wait before they go out. The wait is
 * bounded (`maxWaitMs`), so a background read issued inside a hold can never deadlock.
 */
import type { ChainReader } from "./reader.js";

export class RpcPriority {
  private holds = 0;
  private waiters: (() => void)[] = [];

  constructor(private readonly maxWaitMs = 10_000) {}

  /** Runs user-facing work; background reads yield until it (and every other hold) is done. */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    this.holds++;
    try {
      return await work();
    } finally {
      if (--this.holds === 0) {
        const w = this.waiters;
        this.waiters = [];
        for (const wake of w) wake();
      }
    }
  }

  /** User-facing work in progress. */
  get active(): number {
    return this.holds;
  }

  private yieldToForeground(): Promise<void> {
    if (this.holds === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.maxWaitMs);
      this.waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** The same reader, but every call first lets active user-facing work finish. */
  background(base: ChainReader): ChainReader {
    const run = async <T>(f: () => Promise<T>): Promise<T> => {
      await this.yieldToForeground();
      return f();
    };
    return {
      chainId: base.chainId,
      assertChainId: () => run(() => base.assertChainId()),
      getLatestBlock: () => run(() => base.getLatestBlock()),
      getNativeBalance: (address, blockNumber) => run(() => base.getNativeBalance(address, blockNumber)),
      multicall: (calls, opts) => run(() => base.multicall(calls, opts)),
      readContract: (call, opts) => run(() => base.readContract(call, opts)),
      getLogs: (q) => run(() => base.getLogs(q)),
      health: () => base.health(),
    };
  }
}
