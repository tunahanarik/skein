/**
 * Trade comparison is its own domain: never APY. Without a quote, only objective market
 * attributes are compared (routing order in graph.ts). With quotes, routes are comparable ONLY for
 * the same input asset, output asset and input amount — then by expected output.
 */
import type { TradeQuote } from "../model/trade.js";

export type QuoteComparability = { comparable: true } | { comparable: false; reason: string };

export function quotesComparable(a: TradeQuote, b: TradeQuote): QuoteComparability {
  if (a.input.asset.key !== b.input.asset.key) return { comparable: false, reason: "different input assets" };
  if (a.expectedOutput.asset.key !== b.expectedOutput.asset.key) return { comparable: false, reason: "different output assets" };
  if (a.input.raw !== b.input.raw) return { comparable: false, reason: "different input amounts" };
  return { comparable: true };
}

/** Orders quotes for the SAME (input, output, amount) by expected output, highest first; throws otherwise. */
export function orderQuotesByOutput(quotes: readonly TradeQuote[]): TradeQuote[] {
  for (let i = 1; i < quotes.length; i++) {
    const c = quotesComparable(quotes[0]!, quotes[i]!);
    if (!c.comparable) throw new Error(`quotes are not comparable: ${c.reason}`);
  }
  return [...quotes].sort((x, y) => (y.expectedOutput.raw > x.expectedOutput.raw ? 1 : y.expectedOutput.raw < x.expectedOutput.raw ? -1 : x.routeId.localeCompare(y.routeId)));
}
