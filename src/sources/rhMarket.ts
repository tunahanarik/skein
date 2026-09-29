/**
 * Robinhood market data: price history of the underlying share of a Stock Token
 * (https://api.robinhood.com/marketdata/historicals/<symbol>/). No auth; only the ticker is sent.
 *
 * Bars flagged `interpolated` (e.g. before a listing date) are synthetic fills and are dropped.
 * The ticker is NOT trusted as identity by itself: callers check the result against the
 * on-chain Chainlink price of the token (src/product/charts.ts).
 */
import { z } from "zod";

export const RH_MARKET_BASE = "https://api.robinhood.com/marketdata/historicals";

export type ChartRange = "1D" | "1W" | "1M" | "1Y";
export const CHART_RANGES: ChartRange[] = ["1D", "1W", "1M", "1Y"];

/** Robinhood query per range (measured live: 5-minute bars for a day incl. extended hours, …). */
export const RH_QUERY: Record<ChartRange, { interval: string; span: string; bounds: string }> = {
  "1D": { interval: "5minute", span: "day", bounds: "trading" },
  "1W": { interval: "10minute", span: "week", bounds: "regular" },
  "1M": { interval: "hour", span: "month", bounds: "regular" },
  "1Y": { interval: "day", span: "year", bounds: "regular" },
};

const barSchema = z.looseObject({
  begins_at: z.string(),
  close_price: z.string().regex(/^\d+(\.\d+)?$/),
  session: z.string().optional(),
  interpolated: z.boolean().optional(),
});
const responseSchema = z.looseObject({ symbol: z.string(), historicals: z.array(barSchema) });

export interface ShareBar {
  t: number; // unix ms
  close: string; // decimal string, USD per share
  extended: boolean; // pre/post market
}

export async function fetchShareHistory(symbol: string, range: ChartRange, f: typeof fetch = fetch): Promise<ShareBar[]> {
  if (!/^[A-Z][A-Z0-9.]{0,9}$/.test(symbol)) throw new Error("bad symbol");
  const q = RH_QUERY[range];
  const url = `${RH_MARKET_BASE}/${encodeURIComponent(symbol)}/?interval=${q.interval}&span=${q.span}&bounds=${q.bounds}`;
  const res = await f(url, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Robinhood market data ${res.status}`);
  const body = responseSchema.parse(await res.json());
  if (body.symbol.toUpperCase() !== symbol.toUpperCase()) throw new Error("symbol mismatch");
  return body.historicals
    .filter((b) => !b.interpolated)
    .map((b) => ({ t: Date.parse(b.begins_at), close: b.close_price, extended: !!b.session && b.session !== "reg" }))
    .filter((b) => Number.isFinite(b.t) && Number(b.close) > 0)
    .sort((a, b) => a.t - b.t);
}
