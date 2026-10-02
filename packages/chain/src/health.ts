/**
 * Just enough RPC health data to tell "our bug" from "provider trouble".
 * Not an observability platform: counters + recent latencies + last error.
 */
export type RpcOutcome = "SUCCESS" | "RATE_LIMITED" | "TIMEOUT" | "ERROR";
export type RpcStatus = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface RpcHealthSnapshot {
  endpoint: string;
  requests: number;
  successes: number;
  failures: number;
  rateLimited: number;
  timeouts: number;
  retries: number;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  latestBlock: string | null;
  lastError: string | null;
  status: RpcStatus;
}

const WINDOW = 200;

export class RpcHealth {
  private requests = 0;
  private successes = 0;
  private failures = 0;
  private rateLimited = 0;
  private timeouts = 0;
  private retries = 0;
  private latencies: number[] = [];
  private recentOutcomes: RpcOutcome[] = [];
  private latestBlock: bigint | null = null;
  private lastError: string | null = null;

  /** `endpoint` is shown in reports, so only the origin is kept (a provider URL can carry a key). */
  readonly endpoint: string;

  constructor(rpcUrl: string) {
    this.endpoint = redactRpcUrl(rpcUrl);
  }

  record(outcome: RpcOutcome, latencyMs: number, error?: string): void {
    this.requests++;
    this.latencies.push(latencyMs);
    if (this.latencies.length > WINDOW) this.latencies.shift();
    this.recentOutcomes.push(outcome);
    if (this.recentOutcomes.length > WINDOW) this.recentOutcomes.shift();
    if (outcome === "SUCCESS") this.successes++;
    else {
      this.failures++;
      if (outcome === "RATE_LIMITED") this.rateLimited++;
      if (outcome === "TIMEOUT") this.timeouts++;
      this.lastError = error ?? outcome;
    }
  }

  recordRetry(): void {
    this.retries++;
  }

  observeBlock(n: bigint): void {
    if (this.latestBlock === null || n > this.latestBlock) this.latestBlock = n;
  }

  snapshot(): RpcHealthSnapshot {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const avg = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : null;
    const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]! : null;
    return {
      endpoint: this.endpoint,
      requests: this.requests,
      successes: this.successes,
      failures: this.failures,
      rateLimited: this.rateLimited,
      timeouts: this.timeouts,
      retries: this.retries,
      avgLatencyMs: avg === null ? null : Math.round(avg),
      p95LatencyMs: p95 === null ? null : Math.round(p95),
      latestBlock: this.latestBlock?.toString() ?? null,
      lastError: this.lastError,
      status: this.status(),
    };
  }

  private status(): RpcStatus {
    if (this.recentOutcomes.length === 0) return "UNKNOWN";
    // three consecutive failures (after retries) = the provider is not answering
    const last = this.recentOutcomes.slice(-3);
    if (last.length === 3 && last.every((o) => o !== "SUCCESS")) return "DOWN";
    return this.recentOutcomes.some((o) => o !== "SUCCESS") ? "DEGRADED" : "HEALTHY";
  }
}

/** Keep scheme + host only. Alchemy/QuickNode put the API key in the path. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : "/…"}`;
  } catch {
    return "invalid-url";
  }
}
