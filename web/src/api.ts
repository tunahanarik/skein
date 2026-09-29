/** Typed client for the read-only JSON API (src/server/api.ts). Same origin only. */
import type { AssetIntelligence, CoverageRow, PortfolioIntelligence } from "../../src/product/types.js";
import type { PriceHistory } from "../../src/product/service.js";
import type { PriceChartData } from "../../src/product/charts.js";
import type { AssetListItem, Wire } from "../../src/server/wire.js";

export type Intelligence = Wire<AssetIntelligence>;
export type Portfolio = Wire<PortfolioIntelligence>;
export type Coverage = Wire<CoverageRow>;
export type History = Wire<PriceHistory>;
export type Chart = Wire<PriceChartData>;
export type Card = Intelligence["categories"][number]["subcategories"][number]["cards"][number];
export type Sub = Intelligence["categories"][number]["subcategories"][number];
export type { AssetListItem };

export class ApiFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { signal: signal ?? null, headers: { Accept: "application/json" }, credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiFailure(0, "NETWORK", "The server could not be reached.");
  }
  const body = (await r.json().catch(() => null)) as { error?: { code: string; message: string } } | null;
  if (!r.ok) throw new ApiFailure(r.status, body?.error?.code ?? "HTTP_" + r.status, body?.error?.message ?? r.statusText);
  return body as T;
}

export const api = {
  assets: (s?: AbortSignal) => get<{ assets: AssetListItem[] }>("/api/assets", s),
  asset: (ref: string, o: { mode?: "debug"; to?: string; amount?: string } = {}, s?: AbortSignal) => {
    const q = new URLSearchParams();
    if (o.mode) q.set("mode", o.mode);
    if (o.to) q.set("to", o.to);
    if (o.amount) q.set("amount", o.amount);
    const qs = q.toString();
    return get<Intelligence>(`/api/assets/${encodeURIComponent(ref)}${qs ? `?${qs}` : ""}`, s);
  },
  portfolio: (address: string, s?: AbortSignal) => get<Portfolio>(`/api/portfolio/${encodeURIComponent(address)}`, s),
  history: (ref: string, s?: AbortSignal) => get<History>(`/api/assets/${encodeURIComponent(ref)}/history`, s),
  chart: (ref: string, range: "1D" | "1W" | "1M" | "1Y", s?: AbortSignal) => get<Chart>(`/api/assets/${encodeURIComponent(ref)}/chart?range=${range}`, s),
  coverage: (s?: AbortSignal) => get<{ rows: Coverage[] }>("/api/coverage", s),
  health: (s?: AbortSignal) => get<{ chainId: number; readOnly: boolean; rpc: { status: string; latestBlock: string | null } }>("/api/health", s),
};
