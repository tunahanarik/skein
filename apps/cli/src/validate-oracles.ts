/**
 * Oracle checks:
 *  1. Chainlink directory parses; the USDG/USD and ETH/USD proxies and the sample Stock Token
 *     feeds exist onchain with the listed decimals, a positive answer and an age inside the
 *     heartbeat.
 *  2. For EVERY Stock Token feed: compare the feed price with Robinhood's own quote, with and
 *     without the uiMultiplier. Tokens whose multiplier is far from 1 decide the question
 *     "does the feed already include the multiplier?".
 * Read-only.
 */
import { type Address } from "viem";
import { chainlinkAggregatorAbi, stockTokenAbi } from "@skein/core/config/abis";
import { ROBINHOOD_CHAIN_ID } from "@skein/networks/chains";
import {
  relativeDeviation,
  tokenPriceFromUnderlying,
  underlyingMidFromQuote,
  type TokenPrice,
} from "@skein/core/lib/stockToken";
import { formatFixed } from "@skein/core/lib/units";
import {
  CHAINLINK_DIRECTORY_URL,
  chainlinkDirectorySchema,
  findFeedByName,
  stockFeedTicker,
  type ChainlinkFeed,
} from "@skein/robinhood/sources/chainlink";
import { canonicalStockTokens, rhjAssetsResponseSchema, rhjPricesResponseSchema, RHJ_BASE_URL } from "@skein/robinhood/sources/robinhood";
import { getJson, makeClient } from "./lib/rpc.js";
import { Report } from "./lib/report.js";

const SAMPLE = ["NVDA", "AAPL", "TSLA", "GOOGL"];

export async function validateOracles(report = new Report("oracles")) {
  const client = makeClient();
  const block = await client.getBlock({ blockTag: "latest" });
  const now = Number(block.timestamp);
  report.info("pinned block", `${block.number} (ts ${now})`);

  const dir = await getJson(CHAINLINK_DIRECTORY_URL);
  const feeds = chainlinkDirectorySchema.safeParse(dir.body);
  if (dir.status !== 200 || !feeds.success) {
    report.fail("chainlink directory", `HTTP ${dir.status} / schema ${feeds.success ? "ok" : feeds.error.message.slice(0, 200)}`);
    return report;
  }
  const stockFeeds = feeds.data.filter((f) => stockFeedTicker(f) !== null);
  report.pass("chainlink directory", `${feeds.data.length} feeds, ${stockFeeds.length} Stock Token feeds`, { fetchedAt: dir.fetchedAt });

  // ---- 1. read every relevant proxy in one multicall ----
  const named = ["USDG / USD", "ETH / USD", "USDE / USD"].map((n) => findFeedByName(feeds.data, n)).filter((f): f is ChainlinkFeed => !!f);
  const all = [...named, ...stockFeeds];
  const reads = await client.multicall({
    blockNumber: block.number,
    contracts: all.flatMap((f) => [
      { address: f.proxyAddress, abi: chainlinkAggregatorAbi, functionName: "decimals" } as const,
      { address: f.proxyAddress, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" } as const,
    ]),
  });
  const onchain = new Map<Address, { price: TokenPrice; updatedAt: number }>();
  all.forEach((f, i) => {
    const dec = reads[i * 2];
    const round = reads[i * 2 + 1];
    if (dec?.status !== "success" || round?.status !== "success") {
      report.fail(`feed ${f.name}`, `read failed at ${f.proxyAddress}`);
      return;
    }
    // one multicall mixes decimals() and latestRoundData(), so narrow each result explicitly
    const decimals = dec.result as number;
    const [, answer, , updatedAt] = round.result as readonly [bigint, bigint, bigint, bigint, bigint];
    const age = now - Number(updatedAt);
    onchain.set(f.proxyAddress, { price: { kind: "TOKEN_PRICE", raw: answer, decimals }, updatedAt: Number(updatedAt) });
    const isSample = named.includes(f) || SAMPLE.includes(stockFeedTicker(f) ?? "");
    if (!isSample) return; // the rest are only used for the cross-check below
    const problems = [
      decimals !== f.decimals ? `decimals ${decimals}≠${f.decimals}` : "",
      answer <= 0n ? "non-positive answer" : "",
    ].filter(Boolean);
    const detail = `${f.proxyAddress} = ${formatFixed(answer, decimals)} (age ${age}s, heartbeat ${f.heartbeat}s)`;
    const evidence = { proxy: f.proxyAddress, answer, decimals, updatedAt, ageSeconds: age, heartbeat: f.heartbeat, threshold: f.threshold };
    if (problems.length) report.fail(`feed ${f.name}`, `${detail}; ${problems.join(", ")}`, evidence);
    else if (age > f.heartbeat) report.warn(`feed ${f.name}`, `${detail}; older than heartbeat`, evidence);
    else report.pass(`feed ${f.name}`, detail, evidence);
  });

  // ---- 2. multiplier semantics across all stock feeds ----
  const [assetsRes, pricesRes] = await Promise.all([getJson(`${RHJ_BASE_URL}/assets`), getJson(`${RHJ_BASE_URL}/prices`)]);
  const assets = rhjAssetsResponseSchema.parse(assetsRes.body).assets;
  const quotes = rhjPricesResponseSchema.parse(pricesRes.body).quotes;
  const canonical = canonicalStockTokens(assets, ROBINHOOD_CHAIN_ID);
  const bySymbol = new Map([...canonical.entries()].map(([address, a]) => [a.tokenSymbol, address] as const));
  const quoteBySymbol = new Map(quotes.map((q) => [q.tokenSymbol, q] as const));

  const mapped = stockFeeds.map((f) => ({ f, ticker: stockFeedTicker(f)!, token: bySymbol.get(stockFeedTicker(f)!) }));
  const unmapped = mapped.filter((m) => !m.token).map((m) => m.ticker);
  if (unmapped.length) report.warn("feed → token mapping", `${unmapped.length} feed tickers not in /rhj/assets: ${unmapped.join(", ")}`);
  const withToken = mapped.filter((m): m is typeof m & { token: Address } => !!m.token);
  const mults = await client.multicall({
    blockNumber: block.number,
    contracts: withToken.map((m) => ({ address: m.token, abi: stockTokenAbi, functionName: "uiMultiplier" }) as const),
  });

  const rows: Record<string, unknown>[] = [];
  withToken.forEach((m, i) => {
    const mult = mults[i]?.status === "success" ? (mults[i].result as bigint) : null;
    const feed = onchain.get(m.f.proxyAddress);
    const q = quoteBySymbol.get(m.ticker);
    const mid = q ? underlyingMidFromQuote(q.bid, q.ask) : null;
    if (!mult || !feed || !mid) {
      rows.push({ ticker: m.ticker, skipped: !mult ? "no multiplier" : !feed ? "no feed" : "no quote" });
      return;
    }
    const devWith = relativeDeviation(feed.price, tokenPriceFromUnderlying(mid, mult));
    const devWithout = relativeDeviation(feed.price, { kind: "TOKEN_PRICE", raw: mid.raw, decimals: mid.decimals });
    rows.push({
      ticker: m.ticker,
      multiplier: formatFixed(mult, 18),
      feed: formatFixed(feed.price.raw, feed.price.decimals),
      feedAgeS: now - feed.updatedAt,
      rhMid: formatFixed(mid.raw, mid.decimals),
      halted: q?.isTradingHalt,
      quoteAt: q?.generatedAt,
      devIfFeedIncludesMultiplier: +devWith.toFixed(5),
      devIfFeedExcludesMultiplier: +devWithout.toFixed(5),
    });
  });
  // A token can only decide the question if its multiplier moves the price by clearly more
  // than feed noise (≥ 5%). None of the feed-covered tokens qualifies today, so we also report
  // a weaker signal: tokens with fresh feeds (≤ 15 min) and a multiplier ≥ 0.05% off 1.0.
  const hasMult = (r: Record<string, unknown>, min: number) => typeof r.multiplier === "string" && Math.abs(Number(r.multiplier) - 1) >= min;
  const fitsInclude = (r: Record<string, unknown>) => (r.devIfFeedIncludesMultiplier as number) < (r.devIfFeedExcludesMultiplier as number);
  const decisive = rows.filter((r) => hasMult(r, 0.05));
  const indicative = rows.filter((r) => hasMult(r, 0.0005) && (r.feedAgeS as number) <= 900);
  const summary =
    `${rows.length} stock feeds compared; decisive (|mult−1| ≥ 5%): ${decisive.filter(fitsInclude).length}/${decisive.length} fit "includes"; ` +
    `indicative (fresh feed, |mult−1| ≥ 0.05%): ${indicative.filter(fitsInclude).length}/${indicative.length} fit "includes"`;
  const evidence = { rows, decisive, indicative };
  if (decisive.length > 0 && decisive.every(fitsInclude)) report.pass("multiplier semantics", `${summary} → feed = underlying × multiplier`, evidence);
  else if (decisive.length > 0 && !decisive.some(fitsInclude)) report.fail("multiplier semantics", `${summary} → feed EXCLUDES multiplier (contradicts docs)`, evidence);
  else if (decisive.length > 0) report.warn("multiplier semantics", `${summary} → CONFLICT`, evidence);
  else report.info("multiplier semantics", `${summary} → LIKELY at best; docs remain the authority`, evidence);

  const maxDev = rows.reduce((m, r) => Math.max(m, (r.devIfFeedIncludesMultiplier as number) ?? 0), 0);
  report.info("feed vs Robinhood quote", `max deviation ${(maxDev * 100).toFixed(2)}% (feed threshold 0.5%, feeds may hold price for up to 24h)`);
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const r = await validateOracles();
  process.exitCode = r.finish();
}
