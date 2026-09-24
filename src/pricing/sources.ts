/**
 * Upstream price inputs: the Chainlink feed directory, onchain feed rounds, and Robinhood
 * quotes. Pure data access + validation; selection policy lives in priceService.ts.
 */
import type { Address } from "viem";
import { chainlinkAggregatorAbi } from "../config/abis.js";
import { ROBINHOOD_CHAIN_ID } from "../config/chains.js";
import { CACHE_TTL_MS } from "../config/freshness.js";
import type { ChainReader } from "../chain/reader.js";
import { TtlCache } from "../lib/cache.js";
import type { HttpClient } from "../lib/http.js";
import {
  CHAINLINK_DIRECTORY_URL,
  chainlinkDirectorySchema,
  findFeedByName,
  stockFeedTicker,
  type ChainlinkFeed,
} from "../sources/chainlink.js";
import { rhjPricesResponseSchema, RHJ_BASE_URL, type RhjQuote } from "../sources/robinhood.js";

export const RHJ_PRICES_URL = `${RHJ_BASE_URL}/prices`;

export interface FeedIndex {
  ethUsd: ChainlinkFeed | null;
  usdgUsd: ChainlinkFeed | null;
  /** Stock feeds by ticker. A ticker with two feeds is ambiguous and left out. */
  stockByTicker: Map<string, ChainlinkFeed>;
  ambiguousTickers: string[];
  fetchedAt: string;
}

export function buildFeedIndex(feeds: readonly ChainlinkFeed[], fetchedAt: string): FeedIndex {
  const groups = new Map<string, ChainlinkFeed[]>();
  for (const f of feeds) {
    const t = stockFeedTicker(f);
    if (t) groups.set(t, [...(groups.get(t) ?? []), f]);
  }
  const stockByTicker = new Map<string, ChainlinkFeed>();
  const ambiguousTickers: string[] = [];
  for (const [t, g] of groups) {
    if (g.length === 1) stockByTicker.set(t, g[0]!);
    else ambiguousTickers.push(t);
  }
  return {
    ethUsd: findFeedByName(feeds, "ETH / USD") ?? null,
    usdgUsd: findFeedByName(feeds, "USDG / USD") ?? null,
    stockByTicker,
    ambiguousTickers,
    fetchedAt,
  };
}

const directoryCache = new TtlCache<FeedIndex>();

export function loadFeedIndex(http: HttpClient, cache: TtlCache<FeedIndex> = directoryCache): Promise<FeedIndex> {
  return cache.getOrLoad("chainlink-directory-4663", CACHE_TTL_MS.CHAINLINK_DIRECTORY, async () => {
    const res = await http.getJson(CHAINLINK_DIRECTORY_URL, chainlinkDirectorySchema, { maxBytes: 1_000_000 });
    return buildFeedIndex(res.data, res.fetchedAt);
  });
}

export interface RawRound {
  proxy: Address;
  ok: boolean;
  error: string | null;
  decimals: number | null;
  roundId: bigint;
  answer: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

/** decimals() + latestRoundData() for every proxy, in one multicall pass. */
export async function readFeedRounds(reader: ChainReader, proxies: readonly Address[], blockNumber: bigint): Promise<Map<string, RawRound>> {
  const unique = [...new Set(proxies.map((p) => p.toLowerCase()))] as Address[];
  const res = await reader.multicall(
    unique.flatMap((proxy) => [
      { address: proxy, abi: chainlinkAggregatorAbi, functionName: "decimals" },
      { address: proxy, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" },
    ]),
    { blockNumber },
  );
  const out = new Map<string, RawRound>();
  unique.forEach((proxy, i) => {
    const d = res[i * 2];
    const r = res[i * 2 + 1];
    if (d?.status !== "success" || r?.status !== "success") {
      const err = d?.status === "failure" ? d.error : r?.status === "failure" ? r.error : "missing result";
      out.set(proxy, { proxy, ok: false, error: err, decimals: null, roundId: 0n, answer: 0n, updatedAt: 0n, answeredInRound: 0n });
      return;
    }
    const [roundId, answer, , updatedAt, answeredInRound] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
    out.set(proxy, { proxy, ok: true, error: null, decimals: Number(d.result), roundId, answer, updatedAt, answeredInRound });
  });
  return out;
}

/** Chainlink-recommended sanity checks on a round (independent of age). */
export function roundProblem(r: RawRound, expectedDecimals: number): string | null {
  if (!r.ok) return `read failed: ${r.error}`;
  if (r.decimals !== expectedDecimals) return `decimals ${r.decimals} ≠ directory ${expectedDecimals}`;
  if (r.answer <= 0n) return "non-positive answer";
  if (r.updatedAt <= 0n) return "updatedAt is 0";
  if (r.answeredInRound < r.roundId) return "answeredInRound < roundId";
  return null;
}

export interface QuoteBook {
  /** Keyed by lowercase contract address on 4663 (from the quote's own deployments). */
  byAddress: Map<string, RhjQuote>;
  fetchedAt: string;
}

const quoteCache = new TtlCache<QuoteBook>();

/**
 * All quotes in one request. The bulk endpoint is live-verified but not in the docs (they
 * prefer /prices/{symbol}); one bulk call avoids N+1 requests for a 160-token wallet.
 * Quotes are matched to tokens by contract ADDRESS from the quote's deployments, never by symbol.
 */
export function loadQuoteBook(http: HttpClient, cache: TtlCache<QuoteBook> = quoteCache): Promise<QuoteBook> {
  return cache.getOrLoad("rhj-prices", CACHE_TTL_MS.ROBINHOOD_QUOTES, async () => {
    const res = await http.getJson(RHJ_PRICES_URL, rhjPricesResponseSchema, { maxBytes: 3_000_000 });
    const byAddress = new Map<string, RhjQuote>();
    const seen = new Set<string>();
    for (const q of res.data.quotes) {
      for (const d of q.deployments ?? []) {
        if (d.chainId !== ROBINHOOD_CHAIN_ID) continue;
        const k = d.contractAddress.toLowerCase();
        // two quotes claiming one contract → trust neither
        if (seen.has(k)) byAddress.delete(k);
        else byAddress.set(k, q);
        seen.add(k);
      }
    }
    return { byAddress, fetchedAt: res.fetchedAt };
  });
}
