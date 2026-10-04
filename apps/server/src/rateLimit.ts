/**
 * Fixed-window-free token bucket per key (per client IP). In memory: a single-process limit that
 * protects the upstream RPC and protocol APIs; a multi-instance deployment needs a shared store.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly maxBuckets = 50_000,
  ) {}

  /** Takes one token from a bucket refilled at `perMinute`/min (burst = perMinute). */
  take(key: string, perMinute: number): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: perMinute, at: t };
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.delete(key); // Map order = last use, so the oldest buckets come first
    this.buckets.set(key, b);
    // Bound memory under abuse by dropping the least recently used tenth; clearing everything
    // would hand every client (the abuser included) a fresh burst (SRV-5).
    if (this.buckets.size > this.maxBuckets) {
      let drop = Math.ceil(this.maxBuckets / 10);
      for (const k of this.buckets.keys()) {
        if (drop-- <= 0) break;
        this.buckets.delete(k);
      }
    }
    return ok;
  }

  get size(): number {
    return this.buckets.size;
  }
}
