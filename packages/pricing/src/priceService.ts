/**
 * Price Service: the ONLY place assets are priced. Future protocol adapters must call it
 * rather than price Stock Tokens themselves.
 *
 * Output price is always USD per ONE WHOLE TOKEN. For Stock Tokens:
 *   - Chainlink Stock Token feed = token price (multiplier included; docs /chain/oracles-and-price-feeds)
 *   - Robinhood quote mid = underlying share price → × uiMultiplier ONCE here → token price
 * so callers value any holding as `rawBalance × priceUsd` and never touch the multiplier.
 *
 * Policy (docs/pricing.md):
 *   Stock Token: Chainlink if FRESH/AGING and valid → else Robinhood mid × m if FRESH/AGING and
 *                not halted → else UNPRICED. Both available → cross-check; > threshold → PRICE_CONFLICT
 *                (Chainlink stays selected, conflict is surfaced).
 *   ETH, WETH:   Chainlink ETH/USD (WETH is 1:1 redeemable for ETH) → else UNPRICED.
 *   USDG:        Chainlink USDG/USD → else UNPRICED (never an assumed $1). pegDeviationBps exposed.
 */
import { ROBINHOOD_CHAIN_ID } from "@skein/networks/chains";
import { chainlinkAggregatorAbi } from "@skein/core/config/abis";
import {
  classifyFreshness,
  STOCK_PRICE_CONFLICT_PCT,
  USDG_PEG_WARNING_BPS,
  type FreshnessRuleId,
} from "@skein/core/config/freshness";
import type { ChainReader } from "@skein/chain/reader";
import type { HttpClient } from "@skein/core/lib/http";
import { relativeDeviation, tokenPriceFromUnderlying, underlyingMidFromQuote } from "@skein/core/lib/stockToken";
import { formatFixed, pow10 } from "@skein/core/lib/units";
import type { DataSource } from "@skein/core/model/provenance";
import { weakestStatus, type VerificationStatus } from "@skein/core/model/verification";
import { warn, type Warning } from "@skein/core/model/warnings";
import type { Asset } from "@skein/robinhood/registry/asset";
import type { ChainlinkFeed } from "@skein/robinhood/sources/chainlink";
import type { RhjQuote } from "@skein/robinhood/sources/robinhood";
import {
  loadFeedIndex,
  loadQuoteBook,
  readFeedRounds,
  roundProblem,
  RHJ_PRICES_URL,
  type FeedIndex,
  type QuoteBook,
  type RawRound,
} from "./sources.js";
import type { ChainlinkReading, Confidence, CrossCheck, MultiplierInput, PriceQuote, RobinhoodQuoteReading, UsdPrice } from "./types.js";

export interface PriceRequest {
  asset: Asset;
  /** Required to turn a Robinhood underlying quote into a token price. */
  multiplier?: MultiplierInput | null;
}

export interface PriceContext {
  blockNumber: bigint;
}

export interface PriceServiceDeps {
  reader: ChainReader;
  http: HttpClient;
  now?: () => Date;
  /** Injected for tests; default to the cached upstream loaders. */
  loadFeedIndex?: () => Promise<FeedIndex>;
  loadQuoteBook?: () => Promise<QuoteBook>;
}

export interface PriceBatch {
  quotes: Map<string, PriceQuote>;
  warnings: Warning[];
  timings: { directoryMs: number; roundsMs: number; quotesMs: number };
}

function usdDisplay(p: UsdPrice): string {
  return formatFixed(p.raw, p.decimals);
}

function chainlinkSource(feed: ChainlinkFeed, blockNumber: bigint, fetchedAt: string, updatedAt: number | null): DataSource {
  return {
    type: "ONCHAIN",
    provider: "chainlink",
    chainId: ROBINHOOD_CHAIN_ID,
    contract: feed.proxyAddress,
    method: `latestRoundData() — ${feed.name}`,
    blockNumber,
    observedAt: fetchedAt,
    ...(updatedAt ? { sourceTimestamp: new Date(updatedAt * 1000).toISOString() } : {}),
  };
}

/** Selects the USDG freshness rule for USDG and exchange-rate feeds read for USDG_RATE assets. */
const USDG_RULE_ASSET = { type: "STABLECOIN", priceMethods: ["CHAINLINK_USDG_USD"] } as unknown as Asset;
const erc4626RateAbi = [{ type: "function", name: "convertToAssets", stateMutability: "view", inputs: [{ name: "shares", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] }] as const;

export class PriceService {
  private readonly now: () => Date;

  constructor(private readonly deps: PriceServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** The Chainlink feed that prices `a`, if the directory has one (same rule as priceAssets). */
  async feedFor(a: Asset): Promise<ChainlinkFeed | null> {
    const index = await (this.deps.loadFeedIndex ?? (() => loadFeedIndex(this.deps.http)))();
    if (a.priceMethods.includes("CHAINLINK_ETH_USD")) return index.ethUsd;
    if (a.priceMethods.includes("CHAINLINK_USDG_USD")) return index.usdgUsd;
    if (a.priceMethods.includes("CHAINLINK_USD_FEED")) return (a.usdFeedName && index.usdByName.get(a.usdFeedName)) || null;
    if (a.type === "STOCK_TOKEN" && a.stockMetadata) return index.stockByTicker.get(a.stockMetadata.rhSymbol) ?? null;
    return null;
  }

  /**
   * The feed's last `n` rounds (one multicall of getRoundData, same phase), oldest first. Display
   * history only: points are Chainlink answers as published (Stock Token feeds already include the
   * multiplier — pricing.md); rounds that fail or look invalid are dropped.
   */
  async feedHistory(a: Asset, blockNumber: bigint, n = 48): Promise<{ feed: ChainlinkFeed; points: { updatedAt: number; answer: bigint; decimals: number }[] } | null> {
    const feed = await this.feedFor(a);
    if (!feed) return null;
    const [latest, dec] = await this.deps.reader.multicall(
      [
        { address: feed.proxyAddress, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" },
        { address: feed.proxyAddress, abi: chainlinkAggregatorAbi, functionName: "decimals" },
      ],
      { blockNumber },
    );
    if (latest?.status !== "success" || dec?.status !== "success") return { feed, points: [] };
    const roundId = (latest.result as readonly bigint[])[0]!;
    const decimals = Number(dec.result);
    const phase = roundId >> 64n;
    const agg = roundId & ((1n << 64n) - 1n);
    const ids: bigint[] = [];
    for (let i = 1n; i <= BigInt(n) && agg - i >= 1n; i++) ids.push((phase << 64n) | (agg - i));
    const rs = ids.length ? await this.deps.reader.multicall(ids.map((id) => ({ address: feed.proxyAddress, abi: chainlinkAggregatorAbi, functionName: "getRoundData", args: [id] })), { blockNumber }) : [];
    const rows = [latest, ...rs]
      .filter((r) => r?.status === "success")
      .map((r) => r!.status === "success" ? (r!.result as readonly bigint[]) : [])
      .filter((r) => r.length >= 4 && r[1]! > 0n && r[3]! > 0n)
      .map((r) => ({ updatedAt: Number(r[3]), answer: r[1]!, decimals }));
    const uniq = [...new Map(rows.map((p) => [p.updatedAt, p])).values()].sort((x, y) => x.updatedAt - y.updatedAt);
    return { feed, points: uniq };
  }

  async priceAssets(requests: readonly PriceRequest[], ctx: PriceContext): Promise<PriceBatch> {
    const warnings: Warning[] = [];
    const fetchedAt = this.now().toISOString();
    const nowS = Math.floor(this.now().getTime() / 1000);

    const t0 = performance.now();
    let index: FeedIndex | null = null;
    try {
      index = await (this.deps.loadFeedIndex ?? (() => loadFeedIndex(this.deps.http)))();
    } catch (e) {
      warnings.push(warn("FEED_DIRECTORY_UNAVAILABLE", `Chainlink directory unavailable: ${(e as Error).message}`));
    }
    const directoryMs = performance.now() - t0;

    // Which feeds do we need? One multicall for all of them.
    const feedFor = (a: Asset): ChainlinkFeed | null => {
      if (!index) return null;
      if (a.priceMethods.includes("CHAINLINK_ETH_USD")) return index.ethUsd;
      if (a.priceMethods.includes("CHAINLINK_USDG_USD")) return index.usdgUsd;
      if (a.priceMethods.includes("CHAINLINK_USD_FEED")) return (a.usdFeedName && index.usdByName.get(a.usdFeedName)) || null;
      if (a.type === "STOCK_TOKEN" && a.stockMetadata) return index.stockByTicker.get(a.stockMetadata.rhSymbol) ?? null;
      return null;
    };
    const feeds = new Map(requests.map((r) => [r.asset.key, feedFor(r.asset)] as const));
    const rated = requests.filter((r) => r.asset.priceMethods.includes("USDG_RATE"));
    const rateFeed = (a: Asset): ChainlinkFeed | null => (a.usdgRate?.kind === "CHAINLINK_FEED" && index?.byName.get(a.usdgRate.feedName)) || null;
    const extra = rated.length && index ? [index.usdgUsd, ...rated.map((r) => rateFeed(r.asset))].filter((f): f is ChainlinkFeed => !!f) : [];
    const t1 = performance.now();
    const proxies = [...new Set([...[...feeds.values()].filter((f): f is ChainlinkFeed => !!f), ...extra].map((f) => f.proxyAddress))];
    const rounds = proxies.length ? await readFeedRounds(this.deps.reader, proxies, ctx.blockNumber) : new Map<string, RawRound>();
    const roundsMs = performance.now() - t1;

    const t2 = performance.now();
    let book: QuoteBook | null = null;
    if (requests.some((r) => r.asset.type === "STOCK_TOKEN")) {
      try {
        book = await (this.deps.loadQuoteBook ?? (() => loadQuoteBook(this.deps.http)))();
      } catch (e) {
        warnings.push(warn("QUOTES_UNAVAILABLE", `Robinhood quotes unavailable: ${(e as Error).message}`));
      }
    }
    const quotesMs = performance.now() - t2;

    // ERC-4626 rates (one multicall): value of one whole share in the vault's asset, at the valuation block.
    const vaultRates = new Map<string, bigint | null>();
    const vaults = rated.filter((r) => r.asset.usdgRate?.kind === "ERC4626" && r.asset.address);
    if (vaults.length) {
      const res = await this.deps.reader
        .multicall(vaults.map((r) => ({ address: r.asset.address!, abi: erc4626RateAbi, functionName: "convertToAssets", args: [10n ** BigInt(r.asset.decimals)] })), { blockNumber: ctx.blockNumber })
        .catch(() => vaults.map(() => null));
      vaults.forEach((r, i) => vaultRates.set(r.asset.key, res[i]?.status === "success" ? (res[i]!.result as bigint) : null));
    }

    const quotes = new Map<string, PriceQuote>();
    for (const r of requests) {
      if (r.asset.priceMethods.includes("USDG_RATE")) {
        const usdgFeed = index?.usdgUsd ?? null;
        const usdgRound = usdgFeed ? rounds.get(usdgFeed.proxyAddress.toLowerCase()) ?? null : null;
        const usdgReading = usdgFeed && usdgRound ? this.reading(usdgFeed, usdgRound, USDG_RULE_ASSET, nowS) : null;
        const rf = rateFeed(r.asset);
        const rateRound = rf ? rounds.get(rf.proxyAddress.toLowerCase()) ?? null : null;
        const rateReading = rf && rateRound ? this.reading(rf, rateRound, USDG_RULE_ASSET, nowS) : null;
        quotes.set(r.asset.key, this.priceUsdgRate(r, usdgFeed, usdgReading, rf, rateReading, vaultRates.get(r.asset.key) ?? null, ctx, fetchedAt));
        continue;
      }
      const feed = feeds.get(r.asset.key) ?? null;
      const round = feed ? rounds.get(feed.proxyAddress.toLowerCase()) ?? null : null;
      const reading = feed && round ? this.reading(feed, round, r.asset, nowS) : null;
      quotes.set(r.asset.key, this.priceOne(r, feed, reading, book, ctx, fetchedAt, nowS));
    }
    return { quotes, warnings, timings: { directoryMs, roundsMs, quotesMs } };
  }

  /**
   * A yield-bearing USDG token: rate (Chainlink exchange-rate feed, or ERC-4626 convertToAssets read
   * onchain) × Chainlink USDG/USD. Both inputs must be usable; there is no assumed rate or peg.
   */
  private priceUsdgRate(
    r: PriceRequest,
    usdgFeed: ChainlinkFeed | null,
    usdg: ChainlinkReading | null,
    rateFeed: ChainlinkFeed | null,
    rateCl: ChainlinkReading | null,
    vaultAssets: bigint | null,
    ctx: PriceContext,
    fetchedAt: string,
  ): PriceQuote {
    const a = r.asset;
    const w: Warning[] = [];
    const provenance: DataSource[] = [];
    const out: PriceQuote = {
      assetKey: a.key, symbol: a.symbol, status: "UNPRICED", priceUsd: null, priceUsdDisplay: null, method: null, sourceType: null, source: null,
      observedAt: null, fetchedAt, ageSeconds: null, freshnessStatus: "UNKNOWN", confidence: null, verificationStatus: "UNVERIFIED",
      chainlink: usdg, robinhoodQuote: null, crossCheck: null, pegDeviationBps: null, unpricedReason: null, warnings: w, provenance,
    };
    const unpriced = (reason: string): PriceQuote => {
      w.push(warn("UNPRICED_ASSET", `${a.symbol}: ${reason}`, { assetKey: a.key }));
      return { ...out, unpricedReason: reason };
    };
    const usable = (c: ChainlinkReading | null) => !!c && c.valid && (c.freshness === "FRESH" || c.freshness === "AGING");
    if (!usdgFeed || !usable(usdg)) return unpriced("USDG / USD feed not usable; no assumed peg");
    const usdgSrc = chainlinkSource(usdgFeed, ctx.blockNumber, fetchedAt, usdg!.updatedAt);
    provenance.push(usdgSrc);
    let rate: { raw: bigint; decimals: number } | null = null;
    let observedAt = usdg!.updatedAt;
    if (a.usdgRate?.kind === "CHAINLINK_FEED") {
      if (!rateFeed) return unpriced(`${a.usdgRate.feedName} feed not found in the Chainlink directory`);
      if (!usable(rateCl)) return unpriced(`${a.usdgRate.feedName} feed not usable (${rateCl?.invalidReason ?? rateCl?.freshness ?? "unread"})`);
      provenance.push(chainlinkSource(rateFeed, ctx.blockNumber, fetchedAt, rateCl!.updatedAt));
      rate = { raw: rateCl!.answer, decimals: rateCl!.decimals };
      observedAt = Math.min(observedAt, rateCl!.updatedAt);
    } else if (a.usdgRate?.kind === "ERC4626") {
      if (vaultAssets === null || vaultAssets <= 0n) return unpriced("convertToAssets(1 share) unreadable");
      provenance.push({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ROBINHOOD_CHAIN_ID, contract: a.address!, method: "convertToAssets(1 share) [USDG, 6 decimals]", blockNumber: ctx.blockNumber, observedAt: fetchedAt });
      rate = { raw: vaultAssets, decimals: 6 };
    } else return unpriced("no USDG rate source");
    // price (USDG/USD decimals) = USDG/USD × rate
    const raw = (usdg!.answer * rate.raw) / 10n ** BigInt(rate.decimals);
    const fresh = usdg!.freshness === "FRESH" && (rateCl === null || rateCl.freshness === "FRESH") ? "FRESH" : "AGING";
    return {
      ...out,
      status: "PRICED",
      priceUsd: { raw, decimals: usdg!.decimals },
      priceUsdDisplay: formatFixed(raw, usdg!.decimals),
      method: "USDG_RATE",
      sourceType: "ONCHAIN",
      source: usdgSrc,
      observedAt: new Date(observedAt * 1000).toISOString(),
      ageSeconds: usdg!.ageSeconds,
      freshnessStatus: fresh,
      confidence: fresh === "FRESH" ? "HIGH" : "MEDIUM",
      verificationStatus: "VERIFIED_ONCHAIN",
    };
  }

  private reading(feed: ChainlinkFeed, round: RawRound, asset: Asset, nowS: number): ChainlinkReading {
    const rule: FreshnessRuleId =
      asset.type === "STOCK_TOKEN"
        ? "CHAINLINK_STOCK_FEED"
        : asset.priceMethods.includes("CHAINLINK_USDG_USD") || (asset.priceMethods.includes("CHAINLINK_USD_FEED") && asset.type === "STABLECOIN")
          ? "CHAINLINK_USDG_USD" // stable: updates on 0.5 % deviation or the heartbeat, so hours-old answers are normal
          : "CHAINLINK_ETH_USD"; // 24/7 crypto
    const problem = roundProblem(round, feed.decimals);
    const updatedAt = Number(round.updatedAt);
    const f = classifyFreshness(rule, problem ? null : updatedAt, nowS, feed.heartbeat);
    return {
      proxy: feed.proxyAddress,
      feedName: feed.name,
      roundId: round.roundId,
      answer: round.answer,
      decimals: round.decimals ?? feed.decimals,
      updatedAt,
      heartbeatSeconds: feed.heartbeat,
      freshness: problem ? "UNKNOWN" : f.status,
      ageSeconds: f.ageSeconds,
      valid: problem === null,
      invalidReason: problem,
    };
  }

  private quoteReading(q: RhjQuote, multiplier: MultiplierInput | null | undefined, nowS: number): RobinhoodQuoteReading {
    const mid = underlyingMidFromQuote(q.bid, q.ask);
    const ts = Date.parse(q.generatedAt);
    const f = classifyFreshness("ROBINHOOD_QUOTE", Number.isFinite(ts) ? Math.floor(ts / 1000) : null, nowS);
    let spreadAbsolute: string | null = null;
    let spreadBps: number | null = null;
    if (mid) {
      // spread = ask − bid, both at the mid's scale
      const askRaw = parseScaled(q.ask, mid.decimals);
      const bidRaw = parseScaled(q.bid, mid.decimals);
      if (askRaw !== null && bidRaw !== null) {
        const spread = askRaw - bidRaw;
        spreadAbsolute = formatFixed(spread, mid.decimals);
        spreadBps = Number((spread * 10_000n * 1_000_000n) / mid.raw) / 1_000_000;
      }
    }
    return {
      symbol: q.tokenSymbol,
      bid: q.bid,
      ask: q.ask,
      underlyingMid: mid ? { raw: mid.raw, decimals: mid.decimals } : null,
      spreadAbsolute,
      spreadBps,
      generatedAt: q.generatedAt,
      isTradingHalt: q.isTradingHalt,
      freshness: f.status,
      ageSeconds: f.ageSeconds,
      tokenMid: mid && multiplier ? (({ raw, decimals }) => ({ raw, decimals }))(tokenPriceFromUnderlying(mid, multiplier.valueE18)) : null,
    };
  }

  private priceOne(
    r: PriceRequest,
    feed: ChainlinkFeed | null,
    cl: ChainlinkReading | null,
    book: QuoteBook | null,
    ctx: PriceContext,
    fetchedAt: string,
    nowS: number,
  ): PriceQuote {
    const a = r.asset;
    const w: Warning[] = [];
    const provenance: DataSource[] = [];
    const base: PriceQuote = {
      assetKey: a.key,
      symbol: a.symbol,
      status: "UNPRICED",
      priceUsd: null,
      priceUsdDisplay: null,
      method: null,
      sourceType: null,
      source: null,
      observedAt: null,
      fetchedAt,
      ageSeconds: null,
      freshnessStatus: "UNKNOWN",
      confidence: null,
      verificationStatus: "UNVERIFIED",
      chainlink: cl,
      robinhoodQuote: null,
      crossCheck: null,
      pegDeviationBps: null,
      unpricedReason: null,
      warnings: w,
      provenance,
    };
    const clSource = feed && cl ? chainlinkSource(feed, ctx.blockNumber, fetchedAt, cl.valid ? cl.updatedAt : null) : null;
    if (clSource) provenance.push(clSource);
    if (cl && !cl.valid) w.push(warn("INVALID_FEED_ROUND", `${cl.feedName}: ${cl.invalidReason}`, { assetKey: a.key }));
    const clUsable = !!cl && cl.valid && (cl.freshness === "FRESH" || cl.freshness === "AGING");
    if (cl && cl.valid && cl.freshness === "STALE") {
      w.push(warn("STALE_PRICE", `${cl.feedName} is ${cl.ageSeconds}s old (heartbeat ${cl.heartbeatSeconds}s); not used`, { assetKey: a.key, details: { ageSeconds: cl.ageSeconds, heartbeatSeconds: cl.heartbeatSeconds } }));
    }
    const fromChainlink = (method: PriceQuote["method"], verification: VerificationStatus): PriceQuote => ({
      ...base,
      status: "PRICED",
      priceUsd: { raw: cl!.answer, decimals: cl!.decimals },
      priceUsdDisplay: formatFixed(cl!.answer, cl!.decimals),
      method,
      sourceType: "ONCHAIN",
      source: clSource,
      observedAt: new Date(cl!.updatedAt * 1000).toISOString(),
      ageSeconds: cl!.ageSeconds,
      freshnessStatus: cl!.freshness,
      verificationStatus: verification,
    });
    const unpriced = (reason: string): PriceQuote => {
      w.push(warn("UNPRICED_ASSET", `${a.symbol}: ${reason}`, { assetKey: a.key }));
      return { ...base, unpricedReason: reason };
    };

    // ---------- UNKNOWN / unsupported ----------
    if (a.priceMethods.length === 0) return unpriced("no verified price source for this asset");

    // ---------- ETH / WETH ----------
    if (a.priceMethods.includes("CHAINLINK_ETH_USD")) {
      if (!feed) return unpriced("ETH / USD feed not found in the Chainlink directory");
      if (!clUsable) return unpriced(`ETH / USD feed not usable (${cl?.invalidReason ?? cl?.freshness ?? "unread"})`);
      if (cl!.freshness === "AGING") w.push(warn("AGING_PRICE", `ETH / USD is ${cl!.ageSeconds}s old`, { assetKey: a.key }));
      // Chainlink answer is onchain; the feed address comes from the official directory.
      const q = fromChainlink("CHAINLINK_ETH_USD", "VERIFIED_OFFICIAL_DOCS");
      return { ...q, confidence: cl!.freshness === "FRESH" ? "HIGH" : "MEDIUM" };
    }

    // ---------- USDG ----------
    if (a.priceMethods.includes("CHAINLINK_USDG_USD")) {
      if (!feed) return unpriced("USDG / USD feed not found in the Chainlink directory");
      if (!clUsable) return unpriced(`USDG / USD feed not usable (${cl?.invalidReason ?? cl?.freshness ?? "unread"}); no assumed-peg fallback`);
      if (cl!.freshness === "AGING") w.push(warn("AGING_PRICE", `USDG / USD is ${cl!.ageSeconds}s old`, { assetKey: a.key }));
      const one = pow10(cl!.decimals);
      const devBps = Number(((cl!.answer - one) * 10_000n * 1_000_000n) / one) / 1_000_000;
      if (Math.abs(devBps) > USDG_PEG_WARNING_BPS) {
        w.push(warn("USDG_PEG_DEVIATION", `USDG/USD ${formatFixed(cl!.answer, cl!.decimals)} is ${devBps.toFixed(1)} bps from $1`, { assetKey: a.key, details: { pegDeviationBps: devBps } }));
      }
      const q = fromChainlink("CHAINLINK_USDG_USD", "VERIFIED_OFFICIAL_DOCS");
      return { ...q, pegDeviationBps: devBps, confidence: cl!.freshness === "FRESH" && Math.abs(devBps) <= USDG_PEG_WARNING_BPS ? "HIGH" : "MEDIUM" };
    }

    // ---------- Crypto tokens with their own USD feed ----------
    if (a.priceMethods.includes("CHAINLINK_USD_FEED")) {
      const name = a.usdFeedName ?? "?";
      if (!feed) return unpriced(`${name} feed not found in the Chainlink directory`);
      if (!clUsable) return unpriced(`${name} feed not usable (${cl?.invalidReason ?? cl?.freshness ?? "unread"})`);
      if (cl!.freshness === "AGING") w.push(warn("AGING_PRICE", `${name} is ${cl!.ageSeconds}s old`, { assetKey: a.key }));
      const q = fromChainlink("CHAINLINK_USD_FEED", "VERIFIED_OFFICIAL_DOCS");
      return { ...q, confidence: cl!.freshness === "FRESH" ? "HIGH" : "MEDIUM" };
    }

    // ---------- Stock Tokens ----------
    if (a.type !== "STOCK_TOKEN" || !a.address) return unpriced("unsupported price method");
    if (!feed) w.push(warn("NO_CHAINLINK_FEED", `${a.symbol} has no Chainlink feed in the directory`, { assetKey: a.key }));
    const rq = book?.byAddress.get(a.address.toLowerCase());
    const qr = rq ? this.quoteReading(rq, r.multiplier, nowS) : null;
    const quoteSource: DataSource | null = qr
      ? {
          type: "OFFICIAL_API",
          provider: "robinhood-rhj-api",
          url: RHJ_PRICES_URL,
          chainId: ROBINHOOD_CHAIN_ID,
          method: `quotes[${qr.symbol}] bid/ask (underlying) × uiMultiplier (${r.multiplier?.source ?? "none"})`,
          observedAt: book!.fetchedAt,
          sourceTimestamp: qr.generatedAt,
        }
      : null;
    if (quoteSource) provenance.push(quoteSource);
    if (r.multiplier) provenance.push(r.multiplier.provenance);
    if (qr?.isTradingHalt) w.push(warn("TRADING_HALTED", `${a.symbol}: Robinhood reports a trading halt`, { assetKey: a.key }));
    const quoteUsable =
      !!qr && !!qr.tokenMid && !qr.isTradingHalt && (qr.freshness === "FRESH" || qr.freshness === "AGING");

    // Cross-check whenever both sides are usable.
    let cross: CrossCheck | null = null;
    if (clUsable && qr?.tokenMid && !qr.isTradingHalt && (qr.freshness === "FRESH" || qr.freshness === "AGING")) {
      const feedPrice = { kind: "TOKEN_PRICE" as const, raw: cl!.answer, decimals: cl!.decimals };
      const pct = relativeDeviation(feedPrice, { kind: "TOKEN_PRICE", ...qr.tokenMid }) * 100;
      const scale = Math.max(cl!.decimals, qr.tokenMid.decimals);
      const fa = cl!.answer * pow10(scale - cl!.decimals);
      const qa = qr.tokenMid.raw * pow10(scale - qr.tokenMid.decimals);
      cross = {
        performed: true,
        reason: null,
        absoluteDifference: formatFixed(fa > qa ? fa - qa : qa - fa, scale),
        percentageDifference: +pct.toFixed(6),
        thresholdPct: STOCK_PRICE_CONFLICT_PCT,
        conflict: pct > STOCK_PRICE_CONFLICT_PCT,
      };
      if (cross.conflict) {
        w.push(
          warn("PRICE_CONFLICT", `${a.symbol}: Chainlink ${formatFixed(cl!.answer, cl!.decimals)} vs Robinhood-implied ${formatFixed(qr.tokenMid.raw, qr.tokenMid.decimals)} differ by ${pct.toFixed(3)}%`, {
            assetKey: a.key,
            details: { percentageDifference: +pct.toFixed(6), thresholdPct: STOCK_PRICE_CONFLICT_PCT, multiplierE18: r.multiplier?.valueE18.toString() ?? null },
          }),
        );
      }
    } else {
      cross = {
        performed: false,
        reason: !clUsable ? "no usable Chainlink price" : !qr ? "no Robinhood quote" : !qr.tokenMid ? "no multiplier or no valid mid" : qr.isTradingHalt ? "trading halted" : `quote ${qr.freshness}`,
        absoluteDifference: null,
        percentageDifference: null,
        thresholdPct: STOCK_PRICE_CONFLICT_PCT,
        conflict: false,
      };
    }

    const withQuote = { robinhoodQuote: qr, crossCheck: cross };
    if (clUsable) {
      if (cl!.freshness === "AGING") w.push(warn("AGING_PRICE", `${cl!.feedName} is ${cl!.ageSeconds}s old`, { assetKey: a.key }));
      const confidence: Confidence = cross.conflict ? "LOW" : cl!.freshness === "FRESH" && cross.performed ? "HIGH" : cl!.freshness === "FRESH" || cross.performed ? "MEDIUM" : "LOW";
      // Feed value is onchain; feed↔token mapping is by ticker from the official directory.
      return { ...fromChainlink("CHAINLINK_STOCK_TOKEN_FEED", "VERIFIED_OFFICIAL_DOCS"), ...withQuote, confidence };
    }
    if (quoteUsable) {
      w.push(warn("PRICE_FALLBACK_USED", `${a.symbol}: priced from Robinhood quote mid × uiMultiplier (${feed ? "Chainlink not usable" : "no Chainlink feed"})`, { assetKey: a.key }));
      if (qr!.freshness === "AGING") w.push(warn("AGING_PRICE", `${a.symbol} quote is ${qr!.ageSeconds}s old`, { assetKey: a.key }));
      const verification = weakestStatus(["VERIFIED_OFFICIAL_API", r.multiplier!.source === "ONCHAIN" ? "VERIFIED_ONCHAIN" : "VERIFIED_OFFICIAL_API"]);
      return {
        ...base,
        ...withQuote,
        status: "PRICED",
        priceUsd: qr!.tokenMid,
        priceUsdDisplay: usdDisplay(qr!.tokenMid!),
        method: "ROBINHOOD_QUOTE_MID",
        sourceType: "OFFICIAL_API",
        source: quoteSource,
        observedAt: qr!.generatedAt,
        ageSeconds: qr!.ageSeconds,
        freshnessStatus: qr!.freshness,
        confidence: qr!.freshness === "FRESH" ? "MEDIUM" : "LOW",
        verificationStatus: verification,
      };
    }
    const why = [
      !feed ? "no Chainlink feed" : !cl ? "feed unread" : !cl.valid ? `feed invalid (${cl.invalidReason})` : `feed ${cl.freshness}`,
      !qr ? "no Robinhood quote" : qr.isTradingHalt ? "quote halted" : !qr.underlyingMid ? "quote has no valid bid/ask" : !r.multiplier ? "no multiplier for quote conversion" : `quote ${qr.freshness}`,
    ].join("; ");
    return { ...unpriced(why), ...withQuote };
  }
}

/** Exact decimal string → integer at `decimals`, or null (never throws). */
function parseScaled(v: string, decimals: number): bigint | null {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(v.trim());
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  return BigInt(m[1]!) * pow10(decimals) + (decimals ? BigInt(frac) : 0n);
}
