/**
 * Developer tool (read-only): inspect how asset A trades into asset B on Robinhood Chain.
 *
 *   pnpm trade:inspect --from NVDA --to USDG [--amount 1] [--json]
 *
 * Prints candidate DIRECT markets (every discovered pool for the pair, eligible or not, with why),
 * candidate ONE_HOP routes via the allowlisted routing assets, liquidity, fees, verification,
 * and — only with an explicit --amount — an INDICATIVE quote per route. Nothing is executable.
 */
import { parseUnits } from "viem";
import { formatFixed18, formatPercent } from "@skein/core/lib/fixed";
import { parseAddress, ValidationError } from "@skein/core/lib/validation";
import { createRuntime } from "@skein/runtime/runtime";

const argv = process.argv.slice(2);
const arg = (k: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
};
const json = argv.includes("--json");

try {
  const rt = createRuntime();
  const registry = await rt.getRegistry();
  const resolve = (input: string | undefined, flag: string) => {
    if (!input) throw new ValidationError(`${flag} is required`);
    if (/^0x/i.test(input)) {
      const a = registry.get(4663, parseAddress(input));
      if (!a || !a.canonical) throw new ValidationError(`${input} is not a canonical registry asset`);
      return a;
    }
    const hits = registry.canonicalBySymbol(input);
    if (hits.length !== 1) throw new ValidationError(`symbol "${input}" matches ${hits.length} canonical assets; pass the contract address`);
    return hits[0]!;
  };
  const from = resolve(arg("--from"), "--from");
  const to = resolve(arg("--to"), "--to");
  const amount = arg("--amount");
  let amountRaw: bigint | null = null;
  if (amount !== undefined) {
    if (!/^\d+(\.\d+)?$/.test(amount)) throw new ValidationError("--amount must be a positive decimal number");
    amountRaw = parseUnits(amount, from.decimals);
    if (amountRaw <= 0n) throw new ValidationError("--amount must be positive");
  }

  const t0 = performance.now();
  const markets = await rt.opportunities.getTradeMarkets();
  const pair = markets.data.filter((m) => m.assets.some((a) => a.key === from.key) && m.assets.some((a) => a.key === to.key));
  const routes = await rt.opportunities.getTradeRoutes(from.key, to.key);
  const all = [...routes.data.direct, ...routes.data.oneHop];
  const tq = performance.now();
  const quotes = amountRaw === null ? [] : await Promise.all(all.map((r) => rt.opportunities.getTradeQuote(r, amountRaw!)));
  const quoteMs = Math.round(performance.now() - tq);
  const rejected = new Map(routes.data.rejected.map((r) => [r.marketId, r.reason]));

  if (json) {
    console.log(JSON.stringify({ from: from.key, to: to.key, directMarkets: pair, routes: routes.data, quotes, timingsMs: { total: Math.round(performance.now() - t0), quotes: quoteMs } }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    console.log(`TRADE INSPECT ${from.symbol} (${from.address}) → ${to.symbol} (${to.address})  block ${markets.blockNumber}  status ${markets.status}`);
    console.log(`\nCandidate DIRECT markets (all discovered for this pair): ${pair.length}`);
    for (const m of pair) {
      console.log(`  ${m.protocol.name} ${m.venueKind} ${m.marketId}  fee ${m.fee?.value.ppm ?? "?"} ppm  state ${m.state}  TVL ${m.liquidity.tvl ? "$" + m.liquidity.tvl.value.display.slice(0, 14) : "unknown"}  origin ${m.originVerified ? "verified" : "NOT verified"}  ${rejected.has(m.id) ? `→ not a routing edge: ${rejected.get(m.id)}` : "→ routing edge"}`);
    }
    console.log(`\nRoutes (${routes.data.direct.length} direct, ${routes.data.oneHop.length} one-hop via USDG/WETH; order ${routes.data.ordering})`);
    all.forEach((r, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${r.kind.padEnd(8)} ${[r.input, ...r.intermediates, r.output].map((a) => a.symbol).join(" → ")}  bottleneck TVL ${r.properties.bottleneckTvlUsd ? "$" + r.properties.bottleneckTvlUsd.display.slice(0, 14) : "unknown"}  fee ${r.properties.combinedFeePpm ?? "?"} ppm`);
      const q = quotes[i];
      if (q?.ok) console.log(`      INDICATIVE: ${q.quote.input.display} → ${q.quote.expectedOutput.display} ${q.quote.expectedOutput.asset.symbol}  price ${formatFixed18(q.quote.effectivePrice)}  impact ${q.quote.priceImpact === null ? "n/a" : formatPercent(q.quote.priceImpact, 4)}  (block ${q.quote.blockNumber}; not guaranteed; no minimum output)`);
      else if (q) console.log(`      quote unavailable: ${q.reason}`);
    });
    console.log(`\ntimings: total ${Math.round(performance.now() - t0)} ms, graph ${routes.data.graphMs} ms, quotes ${quoteMs} ms`);
  }
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(`invalid input: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
