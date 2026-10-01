/**
 * Uniswap-v3-style TRADE adapter (the Phase 4 reference; dialects: Uniswap v3, Ramses CL). Read-only.
 *
 * Discovery (no pool addresses are hardcoded):
 *   1. factory PoolCreated events — a RESUMABLE, topic-filtered cold scan (tasks split by tokens on
 *      provider timeouts), then incremental scans of new blocks; persisted via a PoolListStore
 *   2. while that event index is incomplete: the factory's own getPool(token, hub, fee) sweep
 * Every pool passes onchain identity checks (factory origin, token/fee round trip, ordering, tick
 * spacing) before it is used; the checks are immutable facts, persisted and re-verified after
 * POOL_IDENTITY.
 *
 * Caches (TTLs in src/config/freshness.ts):
 *   pool list        store + memory; incremental rescan after POOL_LIST
 *   pool identity    POOL_IDENTITY (24 h), persisted across processes
 *   pool state       primary pools (both tokens canonical): every block; secondary pools (a
 *                    non-registry token): reused up to POOL_STATE_SECONDARY, labelled with its block
 *   quotes           per (route, amount, block), QUOTE
 * The route graph is not cached: it is derived from the current markets on demand.
 * Failures are never cached.
 */
import type { Address } from "viem";
import { CACHE_TTL_MS } from "../../config/freshness.js";
import { DISCOVERY_SCAN_BUDGET_MS, ROUTING_POLICY } from "../../config/trade.js";

import { sanitizeSymbol } from "../../lib/sanitize.js";
import { formatFixed } from "../../lib/units.js";
import type { AssetRef, Opportunity, OpportunityCategory } from "../../model/opportunity.js";
import type { DataSource } from "../../model/provenance.js";
import type { QuoteResult, TradeMarket, TradeQuote, TradeRoute } from "../../model/trade.js";
import { warn, type Warning } from "../../model/warnings.js";
import { classifyFreshness } from "../../config/freshness.js";
import { isLogRangeError } from "../../chain/reader.js";
import type { AdapterCapabilities, AdapterContext, AdapterIssue, AdapterResult, OpportunityAdapter, ResultStatus } from "../../opportunities/adapter.js";
import { priceCanonicalAssets } from "../../opportunities/assetPricing.js";
import { assetKey } from "../../registry/asset.js";
import { UNISWAP_V3, type V3Dialect } from "./constants.js";
import { hopFee, hopSpotRational, priceImpact } from "./math.js";
import { normalizePool, VENUE_KIND, type UniswapNormalizeContext } from "./normalize.js";
import { coldScanTaskKeys, discoverPoolsIncremental, resolveScanTask, runScanTask, splitScanTaskKey, sweepFactoryPools, quoteExactInputSingle, readPoolIdentities, readPoolStates, type DiscoveredPool, type PoolIdentity, type PoolState } from "./onchain.js";
import { MemoryPoolListStore, type PoolListStore } from "./poolStore.js";

interface Snapshot {
  block: bigint;
  takenAt: number;
  opportunities: Opportunity[];
  markets: Map<string, TradeMarket>;
  identities: Map<string, PoolIdentity>;
  states: Map<string, PoolState>;
  warnings: Warning[];
  issues: AdapterIssue[];
  status: ResultStatus;
  timingsMs: Record<string, number>;
  generatedAt: string;
  nowS: number;
}

const ms = (t: number) => Math.round(performance.now() - t);

function hashTokens(tokens: readonly string[]): string {
  // FNV-1a over the sorted lowercase set: detects registry changes; not a security hash.
  let h = 0x811c9dc5;
  for (const ch of [...tokens].map((t) => t.toLowerCase()).sort().join(",")) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

export interface UniswapAdapterOptions {
  store?: PoolListStore;
  now?: () => number;
  fromBlock?: bigint;
  /** Wall-clock budget per run for the resumable cold event scan (default DISCOVERY_SCAN_BUDGET_MS). */
  scanBudgetMs?: number;
  /** Which v3-style DEX this adapter reads (default Uniswap v3). */
  dialect?: V3Dialect;
}

export class UniswapAdapter implements OpportunityAdapter {
  readonly protocol: { id: string; name: string };
  readonly dialect: V3Dialect;
  readonly categories: readonly OpportunityCategory[] = ["TRADE"];
  readonly capabilities: AdapterCapabilities = { discovery: true, assetFiltering: false, userPositions: false, singleOpportunity: true, execution: false, quotes: true };

  private readonly store: PoolListStore;
  private readonly clock: () => number;
  private readonly fromBlock: bigint;
  private list: { pools: DiscoveredPool[]; scannedTo: bigint; tokenSetHash: string; checkedAt: number; coldScan: { target: bigint; pending: string[] } | null } | null = null;
  private readonly scanBudgetMs: number;
  private readonly identityCache = new Map<string, { identity: PoolIdentity; block: { number: bigint; timestamp: bigint }; storedAt: number }>();
  private last: Snapshot | null = null;
  private snapInflight: Promise<Snapshot> | null = null;
  private readonly quoteCache = new Map<string, { result: QuoteResult; storedAt: number }>();
  private readonly secondaryState = new Map<string, { state: PoolState; takenAt: number }>();
  /** Instrumentation for tests and performance reports. */
  readonly stats: { fullScans: number; incrementalScans: number; quoteCalls: number; coldTasksRun?: number; taskSplits?: number; stateReads?: number; sweeps?: number } = { fullScans: 0, incrementalScans: 0, quoteCalls: 0 };

  constructor(opts: UniswapAdapterOptions = {}) {
    this.store = opts.store ?? new MemoryPoolListStore();
    this.clock = opts.now ?? (() => Date.now());
    this.fromBlock = opts.fromBlock ?? 0n;
    this.scanBudgetMs = opts.scanBudgetMs ?? DISCOVERY_SCAN_BUDGET_MS;
    this.dialect = opts.dialect ?? UNISWAP_V3;
    this.protocol = { ...this.dialect.protocol };
  }

  supportsCategory(c: OpportunityCategory): boolean {
    return this.categories.includes(c);
  }

  private tokenSets(ctx: AdapterContext) {
    const hubsKeys = new Set(ROUTING_POLICY.routingAssetKeys.map((k) => k.toLowerCase()));
    const canonical = ctx.registry.canonical().filter((a) => a.address !== null);
    const hubs = canonical.filter((a) => hubsKeys.has(a.key.toLowerCase())).map((a) => a.address!);
    const nonHub = canonical.filter((a) => !hubsKeys.has(a.key.toLowerCase())).map((a) => a.address!);
    return { hubs, nonHub, hash: hashTokens([...hubs, "|", ...nonHub]) };
  }

  /**
   * Pool list = event-discovered pools ∪ (while the event index is incomplete) the factory getPool
   * sweep. The event scan is RESUMABLE: a cold scan is a set of tasks over [0, target]; each run
   * works through pending tasks within DISCOVERY_SCAN_BUDGET_MS and persists progress. Once no task
   * is pending, later runs scan only new blocks (after POOL_LIST). A changed token set restarts it.
   */
  private async loadPools(ctx: AdapterContext, issues: AdapterIssue[], warnings: Warning[]): Promise<DiscoveredPool[]> {
    const sets = this.tokenSets(ctx);
    if (!this.list) {
      const s = this.store.load();
      if (s && s.chainId === ctx.chainId && s.factory.toLowerCase() === this.dialect.factory.toLowerCase() && s.tokenSetHash === sets.hash) {
        this.list = { pools: s.pools, scannedTo: s.scannedTo, tokenSetHash: s.tokenSetHash, checkedAt: s.savedAt, coldScan: s.coldScan ?? null };
        // Immutable identity checks already done by an earlier process (re-verified after POOL_IDENTITY).
        for (const [k, v] of Object.entries(s.identities ?? {})) if (!this.identityCache.has(k)) this.identityCache.set(k, { identity: v.identity, block: v.block, storedAt: v.verifiedAt });
      }
    }
    if (!this.list || this.list.tokenSetHash !== sets.hash) {
      this.stats.fullScans++;
      this.list = { pools: [], scannedTo: -1n, tokenSetHash: sets.hash, checkedAt: 0, coldScan: { target: ctx.blockNumber, pending: coldScanTaskKeys(sets.nonHub.length, sets.hubs.length) } };
    }
    const list = this.list;
    const persist = () => {
      list.checkedAt = this.clock();
      this.saveStore(ctx.chainId);
    };
    const merge = (found: DiscoveredPool[]) => {
      const byPool = new Map(list.pools.map((p) => [p.pool.toLowerCase(), p]));
      for (const p of found) {
        const cur = byPool.get(p.pool.toLowerCase());
        if (!cur || (cur.via !== "EVENT" && p.via === "EVENT")) byPool.set(p.pool.toLowerCase(), p); // an event record supersedes a sweep record
      }
      list.pools = [...byPool.values()];
    };

    // 1) resumable cold event scan
    if (list.coldScan && list.coldScan.pending.length) {
      const deadline = this.clock() + this.scanBudgetMs;
      this.stats.coldTasksRun = this.stats.coldTasksRun ?? 0;
      // At least one task per run (progress is guaranteed), then as many as fit in the budget.
      let first = true;
      while (list.coldScan.pending.length && (first || this.clock() < deadline)) {
        first = false;
        const key = list.coldScan.pending[0]!;
        const task = resolveScanTask(key, sets.nonHub, sets.hubs);
        try {
          if (task) merge(await runScanTask(ctx.reader, task, this.fromBlock, list.coldScan.target, this.dialect));
          list.coldScan.pending.shift();
          this.stats.coldTasksRun++;
          persist();
        } catch (e) {
          // A timed-out topic set is split by TOKENS (not by range) and retried; anything else stops this run.
          const halves = isLogRangeError(e) ? splitScanTaskKey(key) : null;
          if (halves) {
            list.coldScan.pending.splice(0, 1, ...halves);
            this.stats.taskSplits = (this.stats.taskSplits ?? 0) + 1;
            persist();
            continue;
          }
          issues.push({ scope: "uniswap:discovery", message: `event scan task ${key} failed (${(e as Error).message.split("\n")[0]}); will resume`, severity: "DEGRADED" });
          break;
        }
      }
      if (!list.coldScan.pending.length) {
        list.scannedTo = list.coldScan.target;
        list.coldScan = null;
        persist();
      } else {
        issues.push({ scope: "uniswap:discovery", message: `event scan in progress: ${list.coldScan.pending.length} tasks pending; token×hub pools covered by the factory getPool sweep`, severity: "DEGRADED" });
        warnings.push(warn("MARKET_DISCOVERY_DEGRADED", `Uniswap pool-event scan incomplete (${list.coldScan.pending.length} tasks pending); pools pairing two non-hub tokens may be missing until it finishes`));
      }
    } else if (this.clock() - list.checkedAt >= CACHE_TTL_MS.POOL_LIST && ctx.blockNumber > list.scannedTo) {
      // 2) incremental scan of new blocks
      try {
        this.stats.incrementalScans++;
        merge(await discoverPoolsIncremental(ctx.reader, new Set(sets.nonHub.map((a) => a.toLowerCase())), new Set(sets.hubs.map((a) => a.toLowerCase())), list.scannedTo + 1n, ctx.blockNumber, this.dialect));
        list.scannedTo = ctx.blockNumber;
        persist();
      } catch (e) {
        const age = this.clock() - list.checkedAt;
        issues.push({ scope: "uniswap:discovery", message: `incremental pool scan failed (${(e as Error).message.split("\n")[0]}); using the list scanned to block ${list.scannedTo}`, severity: "DEGRADED" });
        warnings.push(warn("MARKET_DISCOVERY_DEGRADED", `Uniswap pool discovery failed; using the list scanned to block ${list.scannedTo}`));
        if (age > CACHE_TTL_MS.PROTOCOL_STATE_STALE_FALLBACK) throw e; // too old to serve
      }
    }

    // 3) factory getPool sweep (fast; the factory's own registry) — only while the event index is
    // incomplete; afterwards incremental event scans find every new pool.
    if (list.coldScan?.pending.length) {
      try {
        this.stats.sweeps = (this.stats.sweeps ?? 0) + 1;
        merge(await sweepFactoryPools(ctx.reader, sets.nonHub, sets.hubs, ctx.blockNumber, this.dialect));
      } catch (e) {
        issues.push({ scope: "uniswap:discovery", message: `factory sweep failed (${(e as Error).message.split("\n")[0]})`, severity: "DEGRADED" });
      }
    }
    if (!list.pools.length && list.coldScan?.pending.length) throw new Error("no pools discovered yet (factory sweep and event scan both unavailable)");
    return list.pools;
  }

  private saveStore(chainId: number): void {
    const list = this.list;
    if (!list) return;
    const identities = Object.fromEntries([...this.identityCache.entries()].map(([k, v]) => [k, { identity: v.identity, block: v.block, verifiedAt: v.storedAt }]));
    this.store.save({ version: 1, chainId, factory: this.dialect.factory.toLowerCase() as Address, tokenSetHash: list.tokenSetHash, scannedTo: list.scannedTo, savedAt: list.checkedAt, pools: list.pools.filter((p) => p.via === "EVENT"), coldScan: list.coldScan, identities });
  }

  private async snapshot(ctx: AdapterContext): Promise<Snapshot> {
    if (this.last && this.last.block === ctx.blockNumber && this.clock() - this.last.takenAt < CACHE_TTL_MS.POOL_STATE) return this.last;
    this.snapInflight ??= this.takeSnapshot(ctx).finally(() => {
      this.snapInflight = null;
    });
    return this.snapInflight;
  }

  private async takeSnapshot(ctx: AdapterContext): Promise<Snapshot> {
    const timingsMs: Record<string, number> = {};
    const issues: AdapterIssue[] = [];
    const warnings: Warning[] = [];
    const nowS = Math.floor(ctx.now().getTime() / 1000);
    const generatedAt = ctx.now().toISOString();

    let t = performance.now();
    const pools = await this.loadPools(ctx, issues, warnings);
    timingsMs.discovery = ms(t);

    t = performance.now();
    const now = this.clock();
    const need = pools.filter((p) => {
      const c = this.identityCache.get(p.pool.toLowerCase());
      return !c || now - c.storedAt >= CACHE_TTL_MS.POOL_IDENTITY;
    });
    if (need.length) {
      const read = await readPoolIdentities(ctx.reader, need, ctx.blockNumber, this.dialect);
      for (const p of need) {
        const r = read.get(p.pool.toLowerCase());
        // Only fully readable identities are cached; unreadable ones are retried next run.
        if (r && r.checks.every((c) => c.ok !== null)) this.identityCache.set(p.pool.toLowerCase(), { identity: r, block: { number: ctx.blockNumber, timestamp: ctx.blockTimestamp }, storedAt: now });
        else issues.push({ scope: `uniswap pool ${p.pool.slice(0, 10)}…`, message: "identity partly unreadable; not cached", severity: "DEGRADED" });
      }
      this.saveStore(ctx.chainId);
    }
    const withId = pools.map((p) => ({ p, c: this.identityCache.get(p.pool.toLowerCase()) })).filter((x): x is { p: DiscoveredPool; c: NonNullable<typeof x.c> } => !!x.c);
    timingsMs.identity = ms(t);

    // Primary pools (both tokens canonical): state at this block, always. Secondary pools (a
    // non-registry token): state reused for up to POOL_STATE_SECONDARY, labelled with its block.
    t = performance.now();
    const isCanonical = (a: Address) => ctx.registry.get(ctx.chainId, a)?.canonical === true;
    const primary = withId.filter((x) => isCanonical(x.c.identity.token0) && isCanonical(x.c.identity.token1)).map((x) => x.c.identity);
    const secondary = withId.filter((x) => !(isCanonical(x.c.identity.token0) && isCanonical(x.c.identity.token1))).map((x) => x.c.identity);
    const staleSecondary = secondary.filter((i) => {
      const c = this.secondaryState.get(i.pool.toLowerCase());
      return !c || now - c.takenAt >= CACHE_TTL_MS.POOL_STATE_SECONDARY;
    });
    const states = await readPoolStates(ctx.reader, [...primary, ...staleSecondary], ctx.blockNumber, ctx.blockTimestamp, this.dialect);
    for (const i of staleSecondary) {
      const st = states.get(i.pool.toLowerCase());
      if (st && !st.errors.length) this.secondaryState.set(i.pool.toLowerCase(), { state: st, takenAt: now });
    }
    for (const i of secondary) if (!states.has(i.pool.toLowerCase())) states.set(i.pool.toLowerCase(), this.secondaryState.get(i.pool.toLowerCase())!.state);
    timingsMs.state = ms(t);
    this.stats.stateReads = (this.stats.stateReads ?? 0) + primary.length + staleSecondary.length;

    t = performance.now();
    const keys = new Set<string>();
    for (const { c } of withId) for (const a of [c.identity.token0, c.identity.token1]) keys.add(assetKey(ctx.chainId, a));
    const priced = await priceCanonicalAssets(ctx, keys);
    timingsMs.prices = ms(t);

    const nctx: UniswapNormalizeContext = {
      chainId: ctx.chainId,
      blockNumber: ctx.blockNumber,
      blockTimestamp: ctx.blockTimestamp,
      nowS,
      generatedAt,
      resolveAsset: (address, symbol, decimals): AssetRef => {
        const a = ctx.registry.get(ctx.chainId, address);
        if (a && a.canonical) return { key: a.key, chainId: ctx.chainId, address, symbol: a.symbol, decimals: a.decimals, canonical: true, registryType: a.type };
        return { key: assetKey(ctx.chainId, address), chainId: ctx.chainId, address, symbol: sanitizeSymbol(symbol, 16) || "?", decimals: decimals ?? 18, canonical: false, registryType: null };
      },
      priceOf: priced.priceOf,
      isLookalike: (ref) => !ref.canonical && ctx.registry.canonicalBySymbol(ref.symbol).length > 0,
      dialect: this.dialect,
    };

    t = performance.now();
    const opportunities: Opportunity[] = [];
    const markets = new Map<string, TradeMarket>();
    const identities = new Map<string, PoolIdentity>();
    let failed = 0;
    for (const { p, c } of withId) {
      try {
        const st = states.get(p.pool.toLowerCase()) ?? null;
        if (st?.errors.length) issues.push({ scope: `uniswap pool ${p.pool.slice(0, 10)}…`, message: `state reads failed: ${st.errors.join("; ").slice(0, 200)}`, severity: "DEGRADED" });
        const r = normalizePool({ discovered: p, identity: c.identity, identityBlock: c.block, state: st }, nctx);
        opportunities.push(...r.opportunities);
        markets.set(r.market.id, r.market);
        identities.set(r.market.id, c.identity);
      } catch (e) {
        failed++;
        issues.push({ scope: `uniswap pool ${p.pool.slice(0, 10)}…`, message: (e as Error).message, severity: "FATAL" });
      }
    }
    timingsMs.normalize = ms(t);
    const status: ResultStatus = issues.length || failed ? "PARTIAL" : "COMPLETE";
    const snap: Snapshot = { block: ctx.blockNumber, takenAt: this.clock(), opportunities, markets, identities, states, warnings, issues, status, timingsMs, generatedAt, nowS };
    this.last = snap;
    return snap;
  }

  async getOpportunities(ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>> {
    const s = await this.snapshot(ctx);
    return { data: s.opportunities, status: s.status, issues: s.issues, warnings: s.warnings, timingsMs: s.timingsMs };
  }

  async getOpportunity(id: string, ctx: AdapterContext): Promise<AdapterResult<Opportunity | null>> {
    const s = await this.snapshot(ctx);
    return { data: s.opportunities.find((o) => o.id === id.toLowerCase() || o.id === id) ?? null, status: s.status, issues: s.issues, warnings: [], timingsMs: s.timingsMs };
  }

  /**
   * INDICATIVE quote through QuoterV2 (eth_call only), hop by hop at the request's block, so the
   * intermediate amounts (for per-hop fees) and the spot prices (for price impact) come from the
   * same state. Pool identity and verification come from the latest snapshot (they rarely change);
   * the hop pools' state is read at this block, so a quote never waits for a whole-chain re-read. Refused unless every market is factory-verified, active and both-canonical — so no
   * untrusted token code is executed in the simulation.
   */
  async quoteRoute(route: TradeRoute, amountInRaw: bigint, ctx: AdapterContext): Promise<QuoteResult> {
    if (amountInRaw <= 0n) return { ok: false, reason: "amount must be positive", retryable: false };
    const s = this.last ?? (await this.snapshot(ctx));
    const block = ctx.blockNumber;
    const hops = route.hops.map((h) => ({ h, m: s.markets.get(h.marketId), id: s.identities.get(h.marketId), st: null as PoolState | null }));
    for (const x of hops) {
      if (!x.m || !x.id) return { ok: false, reason: `market ${x.h.marketId} is not a known ${this.dialect.label} market`, retryable: false };
      if (!x.m.assets[0].canonical || !x.m.assets[1].canonical) return { ok: false, reason: "quotes are only produced for canonical assets", retryable: false };
      if (!x.m.originVerified || x.m.verificationStatus !== "VERIFIED_ONCHAIN") return { ok: false, reason: `market ${x.h.marketId} is not verified`, retryable: false };
      if (x.m.state !== "ACTIVE") return { ok: false, reason: `market ${x.h.marketId} is ${x.m.state}`, retryable: false };
    }
    let states = s.states;
    if (s.block !== block) {
      try {
        states = await readPoolStates(ctx.reader, hops.map((x) => x.id!), block, ctx.blockTimestamp, this.dialect);
      } catch (e) {
        return { ok: false, reason: `pool state unreadable: ${(e as Error).message?.split("\n")[0] ?? "error"}`, retryable: true };
      }
    }
    for (const x of hops) {
      x.st = states.get(x.id!.pool.toLowerCase()) ?? null;
      if (!x.st?.sqrtPriceX96) return { ok: false, reason: "pool state unreadable", retryable: true };
    }
    const cacheKey = `${route.id}|${amountInRaw}|${block}`;
    const hit = this.quoteCache.get(cacheKey);
    if (hit && this.clock() - hit.storedAt < CACHE_TTL_MS.QUOTE) return hit.result;

    const src: DataSource = { type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract: this.dialect.quoter, method: "QuoterV2.quoteExactInputSingle (eth_call, per hop)", blockNumber: block, observedAt: ctx.now().toISOString() };
    let amount = amountInRaw;
    let gas = 0n;
    const fees: TradeQuote["fees"] = [];
    const spots: { spot: { num: bigint; den: bigint }; feePpm: number }[] = [];
    try {
      for (const [i, x] of hops.entries()) {
        const id = x.id!;
        const zeroForOne = x.h.from.address.toLowerCase() === id.token0.toLowerCase();
        this.stats.quoteCalls++;
        const d = this.dialect;
        const fee = d.dynamicFee ? (x.st?.fee ?? id.fee) : id.fee;
        const q = await quoteExactInputSingle(ctx.reader, x.h.from.address, x.h.to.address, d.poolKey === "FEE" ? id.fee : id.tickSpacing, amount, block, d);
        fees.push({ hop: i, asset: x.h.from, amount: { raw: hopFee(amount, fee), decimals: x.h.from.decimals, display: formatFixed(hopFee(amount, fee), x.h.from.decimals) } });
        spots.push({ spot: hopSpotRational(x.st!.sqrtPriceX96!, zeroForOne), feePpm: fee });
        gas += q.gasEstimate;
        amount = q.amountOut;
      }
    } catch (e) {
      const msg = (e as Error).message?.split("\n")[0] ?? "quote failed";
      // A revert is deterministic for this state (e.g. not enough liquidity); RPC errors are retryable.
      return { ok: false, reason: `quote unavailable: ${msg}`, retryable: !/revert/i.test(msg) };
    }
    const inDec = route.input.decimals;
    const outDec = route.output.decimals;
    const e = 18 + inDec - outDec;
    const effectivePrice = e >= 0 ? (amount * 10n ** BigInt(e)) / amountInRaw : amount / (amountInRaw * 10n ** BigInt(-e));
    const quote: TradeQuote = {
      kind: "INDICATIVE_QUOTE",
      routeId: route.id,
      input: { asset: route.input, raw: amountInRaw, decimals: inDec, display: formatFixed(amountInRaw, inDec) },
      expectedOutput: { asset: route.output, raw: amount, decimals: outDec, display: formatFixed(amount, outDec) },
      effectivePrice,
      fees,
      priceImpact: priceImpact(amountInRaw, amount, spots),
      gasEstimate: gas,
      quotedAt: ctx.now().toISOString(),
      blockNumber: block,
      freshness: classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), Math.floor(ctx.now().getTime() / 1000)),
      source: src,
      verification: "VERIFIED_ONCHAIN",
      warnings: [
        warn("INDICATIVE_QUOTE", "Indicative estimate at one block, not a guaranteed output: the price can move before any execution. No minimum output is given (that needs a user-chosen slippage in a future execution phase)."),
      ],
    };
    const result: QuoteResult = { ok: true, quote };
    this.quoteCache.set(cacheKey, { result, storedAt: this.clock() });
    return result;
  }
}

export { VENUE_KIND };
