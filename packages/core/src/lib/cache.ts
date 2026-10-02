/**
 * Small in-memory TTL cache with request coalescing. Replaceable: callers depend only on
 * `getOrLoad`. Used for the asset registry, the Chainlink directory and Robinhood quotes —
 * never for wallet balances.
 */
export interface CacheEntry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  get(key: string): CacheEntry<T> | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt <= this.now()) return undefined;
    return e;
  }

  /** Last stored value even if expired — for explicit degraded-mode fallbacks only. */
  getStale(key: string): CacheEntry<T> | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: T, ttlMs: number): void {
    const t = this.now();
    this.entries.set(key, { value, storedAt: t, expiresAt: t + ttlMs });
  }

  /** Concurrent callers for the same key share one load. */
  async getOrLoad(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit) return hit.value;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = load()
      .then((v) => {
        this.set(key, v, ttlMs);
        return v;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  clear(): void {
    this.entries.clear();
  }
}
