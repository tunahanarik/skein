import type { Sourced } from "../model/provenance.js";

export type Freshness = "FRESH" | "STALE" | "UNKNOWN_AGE" | "FUTURE";

export interface FreshnessResult {
  status: Freshness;
  /** Seconds between the value's own timestamp and `now`; null when it cannot be known. */
  ageSeconds: number | null;
}

/** Allowed clock skew before a timestamp in the future is treated as suspicious. */
const FUTURE_TOLERANCE_S = 60;

function parseTime(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Judge a value's age against a per-metric limit. The source's own timestamp (for example
 * Chainlink `updatedAt`) wins over our fetch time: a feed read a second ago can still carry
 * a price from yesterday.
 */
export function freshness(
  value: Pick<Sourced<unknown>, "source">,
  maxAgeSeconds: number,
  now: Date = new Date(),
): FreshnessResult {
  const stamp = value.source.sourceTimestamp ?? value.source.observedAt;
  const t = parseTime(stamp);
  if (t === null) return { status: "UNKNOWN_AGE", ageSeconds: null };
  const ageSeconds = Math.floor((now.getTime() - t) / 1000);
  if (ageSeconds < -FUTURE_TOLERANCE_S) return { status: "FUTURE", ageSeconds };
  return { status: ageSeconds > maxAgeSeconds ? "STALE" : "FRESH", ageSeconds: Math.max(ageSeconds, 0) };
}

/** Unix seconds (as returned by contracts) → ISO string. 0 or negative means "never". */
export function unixToIso(seconds: bigint | number): string | null {
  const s = typeof seconds === "bigint" ? Number(seconds) : seconds;
  if (!Number.isFinite(s) || s <= 0) return null;
  return new Date(s * 1000).toISOString();
}
