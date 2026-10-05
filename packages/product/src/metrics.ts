/**
 * Lightweight, privacy-preserving structured metrics (in memory). Labels are restricted to a fixed
 * vocabulary (metric names, protocol ids, usability reasons, subcategories); wallet addresses,
 * balances, amounts and asset quantities are never recorded. `snapshot()` is what a future
 * exporter would read.
 */
export type MetricName =
  | "adapter_latency_ms"
  | "asset_intelligence_latency_ms"
  | "portfolio_intelligence_latency_ms"
  | "portfolio_positions_latency_ms"
  | "coverage_latency_ms"
  | "projection_latency_ms"
  | "quote_latency_ms"
  | "opportunities_discovered"
  | "opportunities_actionable"
  | "opportunities_limited"
  | "opportunities_hidden"
  | "hidden_by_reason"
  | "cache_hit"
  | "cache_miss";

/** Label values must match this pattern: short machine identifiers only (no 0x…, no numbers > 4 digits). */
const SAFE_LABEL = /^[A-Za-z_][A-Za-z0-9_:-]{0,48}$/;

export class Metrics {
  private readonly counters = new Map<string, number>();
  private readonly timings = new Map<string, number[]>();

  private key(name: MetricName, labels: Record<string, string>): string {
    const parts = Object.entries(labels)
      .map(([k, v]) => {
        if (!SAFE_LABEL.test(k) || !SAFE_LABEL.test(v) || /0x[0-9a-f]{6,}/i.test(v)) throw new Error(`unsafe metric label ${k}`);
        return `${k}=${v}`;
      })
      .sort();
    return parts.length ? `${name}{${parts.join(",")}}` : name;
  }

  inc(name: MetricName, by = 1, labels: Record<string, string> = {}): void {
    const k = this.key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  time(name: MetricName, ms: number, labels: Record<string, string> = {}): void {
    const k = this.key(name, labels);
    const a = this.timings.get(k) ?? [];
    a.push(Math.round(ms));
    if (a.length > 200) a.shift();
    this.timings.set(k, a);
  }

  snapshot(): { counters: Record<string, number>; timings: Record<string, { count: number; p50: number; p95: number; max: number }> } {
    const timings: Record<string, { count: number; p50: number; p95: number; max: number }> = {};
    for (const [k, a] of this.timings) {
      const s = [...a].sort((x, y) => x - y);
      const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
      timings[k] = { count: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]! };
    }
    return { counters: Object.fromEntries(this.counters), timings };
  }
}
