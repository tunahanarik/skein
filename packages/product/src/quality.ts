/**
 * Product-level provenance, freshness and data-quality summaries. Ages are computed at RESPONSE
 * time from source timestamps, so rebuilding a projection (or serving it from cache) never makes a
 * stale value look fresh.
 */
import { classifyFreshness, type FreshnessRuleId, type FreshnessStatus } from "@skein/core/config/freshness";
import type { Measured, Opportunity } from "@skein/core/model/opportunity";
import type { DataSource } from "@skein/core/model/provenance";
import type { DataQuality, FreshnessSummary, SourceSummary } from "./types.js";

const PROVIDER_NAMES: Record<string, string> = {
  "robinhood-chain-rpc": "Robinhood Chain",
  "morpho-api": "Morpho",
  "morpho-blue-source": "Morpho",
  "pendle-api": "Pendle",
  "pendle-docs": "Pendle",
  "pendle-deployments": "Pendle",
  "uniswap-deployments": "Uniswap",
  "uniswap-v3-core": "Uniswap",
  chainlink: "Chainlink",
  "robinhood-rhj-api": "Robinhood",
  "defi-router": "Derived",
};

export function providerName(p: string): string {
  return PROVIDER_NAMES[p] ?? p;
}

export function summarizeSources(sources: readonly DataSource[]): SourceSummary[] {
  const seen = new Map<string, SourceSummary>();
  for (const s of sources) {
    const provider = providerName(s.provider);
    const k = `${provider}|${s.type}`;
    if (!seen.has(k)) seen.set(k, { provider, type: s.type });
  }
  return [...seen.values()].sort((a, b) => (a.provider + a.type).localeCompare(b.provider + b.type));
}

/** All sources behind an opportunity: its provenance plus every metric's own source. */
export function opportunitySources(o: Opportunity): DataSource[] {
  return [...o.provenance, ...o.yields.map((y) => y.source), ...(o.tvl ? [o.tvl.source] : []), ...(o.availableLiquidity ? [o.availableLiquidity.source] : [])];
}

export interface TimedValue {
  what: string;
  provider: string;
  observedAt: string;
  rule: FreshnessRuleId;
}

/** The critical, time-sensitive values of an opportunity (headline yields, liquidity, TVL). */
export function criticalValues(o: Opportunity): TimedValue[] {
  const out: TimedValue[] = [];
  const add = (what: string, m: Measured<unknown> | null | undefined) => {
    if (m) out.push({ what, provider: providerName(m.source.provider), observedAt: m.observedAt, rule: m.freshness.rule });
  };
  for (const y of o.yields) add(`${o.id} ${y.type}`, y);
  add(`${o.id} liquidity`, o.availableLiquidity);
  add(`${o.id} tvl`, o.tvl);
  return out;
}

export function summarizeFreshness(values: readonly TimedValue[], nowS: number): FreshnessSummary {
  let oldest: string | null = null;
  let newest: string | null = null;
  const stale: FreshnessSummary["staleSources"] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = Date.parse(v.observedAt);
    if (!Number.isFinite(t)) continue;
    if (oldest === null || v.observedAt < oldest) oldest = v.observedAt;
    if (newest === null || v.observedAt > newest) newest = v.observedAt;
    const f = classifyFreshness(v.rule, Math.floor(t / 1000), nowS);
    if (f.status === "STALE" || f.status === "UNKNOWN") {
      const k = `${v.provider}|${f.status}|${v.rule}`;
      if (!seen.has(k)) {
        seen.add(k);
        stale.push({ provider: v.provider, status: f.status as FreshnessStatus, ageSeconds: f.ageSeconds, what: v.rule });
      }
    }
  }
  return { oldestCriticalDataAt: oldest, newestDataAt: newest, staleSources: stale, evaluatedAt: new Date(nowS * 1000).toISOString() };
}

export interface AdapterStatus {
  protocol: string;
  status: "COMPLETE" | "PARTIAL" | "UNKNOWN";
  issues: { scope: string; message: string }[];
}

/**
 * COMPLETE: every adapter complete and nothing stale. PARTIAL: an adapter degraded or failed (its
 * categories may be missing; healthy categories are kept). STALE: complete but a critical value is
 * stale. UNKNOWN: no adapter produced data.
 */
export function summarizeDataQuality(adapters: readonly AdapterStatus[], freshness: FreshnessSummary, extra: DataQuality["reasons"] = []): DataQuality {
  const reasons: DataQuality["reasons"] = [...extra];
  for (const a of adapters) {
    if (a.status === "UNKNOWN") reasons.push({ code: `${a.protocol.toUpperCase()}_UNAVAILABLE`, protocol: a.protocol, detail: a.issues[0]?.message.slice(0, 160) ?? "adapter failed" });
    else if (a.status === "PARTIAL") reasons.push({ code: `${a.protocol.toUpperCase()}_PARTIAL`, protocol: a.protocol, detail: a.issues.map((i) => i.message).join("; ").slice(0, 200) });
  }
  for (const s of freshness.staleSources) reasons.push({ code: `STALE_${s.status}`, detail: `${s.provider} ${s.what} age ${s.ageSeconds ?? "?"}s` });
  const status = adapters.length && adapters.every((a) => a.status === "UNKNOWN") ? "UNKNOWN" : adapters.some((a) => a.status !== "COMPLETE") || extra.length ? "PARTIAL" : freshness.staleSources.length ? "STALE" : "COMPLETE";
  return { status, reasons };
}
