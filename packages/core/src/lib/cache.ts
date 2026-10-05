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

/** Default bound on stored entries; keys built from request input can never grow memory past it. */
export const DEFAULT_MAX_CACHE_ENTRIES = 1_000;

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly maxEntries: number;

  /**
   * Expired entries stay (getStale serves them in degraded mode) but the total is bounded: past
   * `maxEntries` the least recently stored entry is dropped.
   */
  constructor(
    private readonly now: () => number = () => Date.now(),
    opts: { maxEntries?: number } = {},
  ) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_CACHE_ENTRIES);
  }

  get size(): number {
    return this.entries.size;
  }

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
    this.entries.delete(key); // re-insert at the end: Map order is store order
    this.entries.set(key, { value, storedAt: t, expiresAt: t + ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
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
