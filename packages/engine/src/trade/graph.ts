/**
 * Generic trade graph and indicative routing (Phase 4). Venue-independent: any adapter can
 * contribute TradeMarkets; this module never reads `TradeMarket.details`.
 *
 *   nodes  canonical assets (by chainId:address key)
 *   edges  verified, readable, active markets with a priced, non-dust TVL whose both assets are canonical
 *
 * Routes are DIRECT or ONE_HOP only. One-hop intermediates come from an explicit allowlist of
 * routing assets (packages/robinhood/src/config/trade.ts) — no arbitrary graph search, no cycles.
 */
import { ROUTING_POLICY, type RoutingPolicy } from "@skein/robinhood/config/trade";
import type { UsdAmount } from "@skein/core/model/opportunity";
import type { RouteOrdering, TradeFee, TradeMarket, TradeRoute } from "@skein/core/model/trade";

export interface EdgeRejection {
  marketId: string;
  reason: "ASSET_NOT_CANONICAL" | "ORIGIN_NOT_VERIFIED" | "STATE_NOT_ACTIVE" | "DUST" | "SIZE_UNKNOWN" | "CONFLICT";
}

export interface TradeGraph {
  /** assetKey → markets touching it (eligible edges only). */
  adjacency: Map<string, TradeMarket[]>;
  markets: Map<string, TradeMarket>;
  rejected: EdgeRejection[];
  builtFrom: number;
}

export function buildTradeGraph(markets: readonly TradeMarket[], policy: RoutingPolicy = ROUTING_POLICY): TradeGraph {
  const adjacency = new Map<string, TradeMarket[]>();
  const byId = new Map<string, TradeMarket>();
  const rejected: EdgeRejection[] = [];
  for (const m of markets) {
    if (byId.has(m.id)) continue; // duplicate market ids are counted once
    let reason: EdgeRejection["reason"] | null = null;
    if (!m.assets[0].canonical || !m.assets[1].canonical) reason = "ASSET_NOT_CANONICAL";
    else if (!m.originVerified) reason = "ORIGIN_NOT_VERIFIED";
    else if (m.verificationStatus === "CONFLICT") reason = "CONFLICT";
    else if (m.state !== "ACTIVE") reason = "STATE_NOT_ACTIVE";
    else if (!m.liquidity.tvl) reason = "SIZE_UNKNOWN"; // non-dust cannot be shown without a priced TVL
    else if (m.liquidity.tvl.value.e18 < policy.minEdgeTvlUsdE18) reason = "DUST";
    if (reason) {
      rejected.push({ marketId: m.id, reason });
      continue;
    }
    byId.set(m.id, m);
    for (const a of m.assets) adjacency.set(a.key, [...(adjacency.get(a.key) ?? []), m]);
  }
  return { adjacency, markets: byId, rejected, builtFrom: markets.length };
}

const other = (m: TradeMarket, key: string) => (m.assets[0].key === key ? m.assets[1] : m.assets[0]);
const connects = (m: TradeMarket, a: string, b: string) => (m.assets[0].key === a && m.assets[1].key === b) || (m.assets[0].key === b && m.assets[1].key === a);

function combinedFeePpm(fees: (TradeFee | null)[]): number | null {
  let keep = 1_000_000n;
  for (const f of fees) {
    if (!f || f.ppm === null) return null;
    keep = (keep * BigInt(1_000_000 - f.ppm)) / 1_000_000n;
  }
  return Number(1_000_000n - keep);
}

function makeRoute(hops: { m: TradeMarket; from: string }[]): TradeRoute {
  const steps = hops.map(({ m, from }) => {
    const fromRef = m.assets[0].key === from ? m.assets[0] : m.assets[1];
    return { marketId: m.id, from: fromRef, to: other(m, from), fee: m.fee?.value ?? null };
  });
  const tvls = hops.map((h) => h.m.liquidity.tvl?.value ?? null);
  const bottleneck: UsdAmount | null = tvls.some((t) => t === null) ? null : tvls.reduce((a, b) => (b!.e18 < a!.e18 ? b : a))!;
  const input = steps[0]!.from;
  const output = steps[steps.length - 1]!.to;
  return {
    id: `${input.key}>${steps.map((s) => s.marketId).join(">")}>${output.key}`,
    input,
    output,
    kind: steps.length === 1 ? "DIRECT" : "ONE_HOP",
    hops: steps,
    intermediates: steps.slice(0, -1).map((s) => s.to),
    properties: {
      hopCount: steps.length,
      combinedFeePpm: combinedFeePpm(steps.map((s) => s.fee)),
      bottleneckTvlUsd: bottleneck,
      allMarketsVerified: hops.every((h) => h.m.originVerified && h.m.verificationStatus !== "CONFLICT"),
      allAssetsCanonical: steps.every((s) => s.from.canonical && s.to.canonical),
      protocols: [...new Set(hops.map((h) => h.m.protocol.id))],
    },
  };
}

/** The DIRECT route through one market, from `inputKey` (which must be one of its assets). */
export function directRoute(m: TradeMarket, inputKey: string): TradeRoute {
  const k = inputKey.toLowerCase();
  if (m.assets[0].key !== k && m.assets[1].key !== k) throw new Error(`asset ${inputKey} is not in market ${m.id}`);
  return makeRoute([{ m, from: k }]);
}

/** Deterministic order for the stated objective. */
export function orderRoutes(routes: TradeRoute[], ordering: RouteOrdering = "BOTTLENECK_TVL_DESC"): TradeRoute[] {
  void ordering; // single objective today; the parameter makes the objective explicit at call sites
  const tvl = (r: TradeRoute) => r.properties.bottleneckTvlUsd?.e18 ?? -1n;
  return [...routes].sort((a, b) => {
    if (tvl(a) !== tvl(b)) return tvl(b) > tvl(a) ? 1 : -1;
    if (a.properties.hopCount !== b.properties.hopCount) return a.properties.hopCount - b.properties.hopCount;
    const fa = a.properties.combinedFeePpm ?? Number.MAX_SAFE_INTEGER;
    const fb = b.properties.combinedFeePpm ?? Number.MAX_SAFE_INTEGER;
    if (fa !== fb) return fa - fb;
    return a.id.localeCompare(b.id);
  });
}

export interface RouteSearch {
  direct: TradeRoute[];
  oneHop: TradeRoute[];
  ordering: RouteOrdering;
}

/** All DIRECT routes and all ONE_HOP routes through allowlisted routing assets. */
export function findRoutes(g: TradeGraph, inputKey: string, outputKey: string, policy: RoutingPolicy = ROUTING_POLICY): RouteSearch {
  const input = inputKey.toLowerCase();
  const output = outputKey.toLowerCase();
  if (input === output) return { direct: [], oneHop: [], ordering: "BOTTLENECK_TVL_DESC" };
  const from = g.adjacency.get(input) ?? [];
  const direct = from.filter((m) => connects(m, input, output)).map((m) => makeRoute([{ m, from: input }]));
  const oneHop: TradeRoute[] = [];
  if (policy.maxHops >= 2) {
    for (const hub of policy.routingAssetKeys.map((k) => k.toLowerCase())) {
      if (hub === input || hub === output) continue; // no cycles through an endpoint
      const first = from.filter((m) => connects(m, input, hub));
      const second = (g.adjacency.get(hub) ?? []).filter((m) => connects(m, hub, output));
      for (const a of first) for (const b of second) oneHop.push(makeRoute([{ m: a, from: input }, { m: b, from: hub }]));
    }
  }
  const dedupe = (rs: TradeRoute[]) => [...new Map(rs.map((r) => [r.id, r])).values()];
  return { direct: orderRoutes(dedupe(direct)), oneHop: orderRoutes(dedupe(oneHop)), ordering: "BOTTLENECK_TVL_DESC" };
}

/** Destinations reachable from an asset: directly, and via one allowlisted routing asset. */
export function destinations(g: TradeGraph, inputKey: string, policy: RoutingPolicy = ROUTING_POLICY): { direct: string[]; oneHop: string[] } {
  const input = inputKey.toLowerCase();
  const direct = new Set((g.adjacency.get(input) ?? []).map((m) => other(m, input).key));
  const oneHop = new Set<string>();
  for (const hub of policy.routingAssetKeys.map((k) => k.toLowerCase())) {
    if (hub === input || !direct.has(hub)) continue;
    for (const m of g.adjacency.get(hub) ?? []) {
      const d = other(m, hub).key;
      if (d !== input && !direct.has(d)) oneHop.add(d);
    }
  }
  return { direct: [...direct].sort(), oneHop: [...oneHop].sort() };
}
