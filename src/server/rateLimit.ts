/**
 * Fixed-window-free token bucket per key (per client IP). In memory: a single-process limit that
 * protects the upstream RPC and protocol APIs; a multi-instance deployment needs a shared store.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Takes one token from a bucket refilled at `perMinute`/min (burst = perMinute). */
  take(key: string, perMinute: number): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: perMinute, at: t };
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute);
    b.at = t;
    if (this.buckets.size > 50_000) this.buckets.clear(); // bound memory under abuse
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}
