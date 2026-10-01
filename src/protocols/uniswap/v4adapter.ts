/**
 * Uniswap v4 TRADE adapter — HOOKLESS pools only (policy for decision P4-1: a hook can run arbitrary
 * code in swaps and quotes; a pool whose PoolKey has hooks = address(0) runs none).
 *
 * Discovery without logs: a pool's id is keccak256(abi.encode(PoolKey)), so for every token × hub
 * pair and every standard fee tier (fee → tickSpacing as on v3) we COMPUTE the id of the hookless
 * pool and ask the official StateView whether it is initialized. Hooklessness is therefore part of
 * the identity itself. Pools with non-standard fee/tickSpacing are not discovered (documented).
 *
 * Reserves: v4 keeps all pools' tokens in the singleton PoolManager, so there is no per-pool
 * balance. We reconstruct the principal inside a ±WINDOW_TICKS window (price ×/÷ 4) from the current
 * liquidity and the liquidityNet of initialized ticks (StateView bitmap + tick reads) — a LOWER
 * BOUND of the pool's reserves, labelled as such (RESERVES_LOWER_BOUND).
 * Quotes: official V4Quoter.quoteExactInputSingle via eth_call, per hop.
 *
 * Addresses: github.com/Uniswap/contracts deployments/json/4663.json (constants.ts, UNISWAP_RECORDED_ONLY).
 */
import { parseAbi, type Address, type Hex } from "viem";
import { CACHE_TTL_MS, classifyFreshness } from "../../config/freshness.js";
import { ROUTING_POLICY } from "../../config/trade.js";
import { formatFixed } from "../../lib/units.js";
import type { AssetRef, Opportunity, OpportunityCategory } from "../../model/opportunity.js";
import type { DataSource } from "../../model/provenance.js";
import type { QuoteResult, TradeMarket, TradeQuote, TradeRoute } from "../../model/trade.js";
import { warn, type Warning } from "../../model/warnings.js";
import type { AdapterCapabilities, AdapterContext, AdapterIssue, AdapterResult, OpportunityAdapter, ResultStatus } from "../../opportunities/adapter.js";
import { priceCanonicalAssets } from "../../opportunities/assetPricing.js";
import { assetKey } from "../../registry/asset.js";
import { UNISWAP_DEPLOYMENT_SOURCE, UNISWAP_RECORDED_ONLY, V3_FEE_TIERS, type V3Dialect } from "./constants.js";
import { hopFee, hopSpotRational, priceImpact } from "./math.js";
import { normalizePool } from "./normalize.js";
import type { DiscoveredPool, PoolIdentity, PoolState } from "./onchain.js";
import { hooklessKey, poolIdOf, ticksInWord, windowReserves, wordOf, type PoolKey } from "./v4math.js";

export const WINDOW_TICKS = 13_863; // ln(4) / ln(1.0001): price × 4 and ÷ 4

export const UNISWAP_V4: V3Dialect = {
  protocol: { id: "uniswap-v4", name: "Uniswap" },
  label: "Uniswap v4",
  factoryLabel: "PoolManager",
  venueKind: "uniswap-v4-pool",
  factory: UNISWAP_RECORDED_ONLY.v4PoolManager,
  quoter: UNISWAP_RECORDED_ONLY.v4Quoter,
  deploymentSource: UNISWAP_DEPLOYMENT_SOURCE,
  poolKey: "FEE",
  tiers: V3_FEE_TIERS,
  dynamicFee: false,
  mutability: "hookless v4 pool: currencies, fee and tickSpacing are fixed in the PoolKey and no hook contract runs",
  mutabilitySource: "https://github.com/Uniswap/v4-core",
  originChecks: ["poolId = keccak256(PoolKey with hooks = 0)", "StateView.getSlot0(poolId) initialized"],
  reservesMethod: "StateView tick walk (±4× price window)",
  reservesWarning: { code: "RESERVES_LOWER_BOUND", text: "v4 keeps tokens in the singleton PoolManager; reserves are the principal of liquidity within ×/÷ 4 of the current price (a lower bound), excluding uncollected fees" },
};

const STATE_VIEW = UNISWAP_RECORDED_ONLY.v4StateView;
export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128)",
  "function getTickBitmap(bytes32 poolId, int16 tick) view returns (uint256)",
  "function getTickLiquidity(bytes32 poolId, int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet)",
]);
export const v4QuoterAbi = parseAbi([
  "function quoteExactInputSingle(((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 exactAmount, bytes hookData) params) returns (uint256 amountOut, uint256 gasEstimate)",
]);
const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

interface V4Pool {
  id: Hex;
  key: PoolKey;
}

interface Snapshot {
  block: bigint;
  takenAt: number;
  opportunities: Opportunity[];
  markets: Map<string, TradeMarket>;
  pools: Map<string, { key: PoolKey; state: PoolState; identity: PoolIdentity }>;
  warnings: Warning[];
  issues: AdapterIssue[];
  status: ResultStatus;
  timingsMs: Record<string, number>;
  generatedAt: string;
  nowS: number;
}

const ms = (t: number) => Math.round(performance.now() - t);

export class UniswapV4Adapter implements OpportunityAdapter {
  readonly protocol = { ...UNISWAP_V4.protocol };
  readonly categories: readonly OpportunityCategory[] = ["TRADE"];
  readonly capabilities: AdapterCapabilities = { discovery: true, assetFiltering: false, userPositions: false, singleOpportunity: false, execution: false, quotes: true };
  private last: Snapshot | null = null;
  private inflight: Promise<Snapshot> | null = null;
  private candidates: { list: V4Pool[]; at: number; hash: string } | null = null;
  private readonly quoteCache = new Map<string, { result: QuoteResult; at: number }>();
  private readonly clock: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.clock = opts.now ?? (() => Date.now());
  }

  supportsCategory(c: OpportunityCategory): boolean {
    return this.categories.includes(c);
  }

  /** Initialized hookless pools for token × hub and hub × hub over the standard fee tiers. */
  private async discover(ctx: AdapterContext): Promise<V4Pool[]> {
    const hubKeys = new Set(ROUTING_POLICY.routingAssetKeys.map((k) => k.toLowerCase()));
    const canonical = ctx.registry.canonical().filter((a) => a.address !== null);
    const hubs = canonical.filter((a) => hubKeys.has(a.key.toLowerCase())).map((a) => a.address!);
    const nonHub = canonical.filter((a) => !hubKeys.has(a.key.toLowerCase())).map((a) => a.address!);
    const hash = `${hubs.join()}|${nonHub.length}`;
    if (this.candidates && this.candidates.hash === hash && this.clock() - this.candidates.at < CACHE_TTL_MS.POOL_LIST) return this.candidates.list;
    const pairs: [Address, Address][] = [];
    for (const t of nonHub) for (const h of hubs) pairs.push([t, h]);
    for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++) pairs.push([hubs[i]!, hubs[j]!]);
    const all: V4Pool[] = pairs.flatMap(([a, b]) => Object.entries(V3_FEE_TIERS).map(([fee, ts]) => {
      const key = hooklessKey(a, b, Number(fee), ts);
      return { id: poolIdOf(key), key };
    }));
    const r = await ctx.reader.multicall(all.map((p) => ({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [p.id] })), { blockNumber: ctx.blockNumber });
    const list = all.filter((_, i) => r[i]?.status === "success" && ((r[i] as { result: readonly bigint[] }).result[0] ?? 0n) > 0n);
    this.candidates = { list, at: this.clock(), hash };
    return list;
  }

  private snapshot(ctx: AdapterContext): Promise<Snapshot> {
    if (this.last && this.last.block === ctx.blockNumber && this.clock() - this.last.takenAt < CACHE_TTL_MS.POOL_STATE) return Promise.resolve(this.last);
    this.inflight ??= this.take(ctx).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async take(ctx: AdapterContext): Promise<Snapshot> {
    const timingsMs: Record<string, number> = {};
    const issues: AdapterIssue[] = [];
    const warnings: Warning[] = [];
    const nowS = Math.floor(ctx.now().getTime() / 1000);
    const generatedAt = ctx.now().toISOString();
    const b = { blockNumber: ctx.blockNumber };

    let t = performance.now();
    const pools = await this.discover(ctx);
    timingsMs.discovery = ms(t);

    // State: slot0 + liquidity for every pool, then bitmap words inside the window, then ticks.
    t = performance.now();
    const s = await ctx.reader.multicall(pools.flatMap((p) => [
      { address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [p.id] },
      { address: STATE_VIEW, abi: stateViewAbi, functionName: "getLiquidity", args: [p.id] },
    ]), b);
    const base = pools.map((p, i) => {
      const s0 = s[i * 2]?.status === "success" ? ((s[i * 2] as { result: readonly [bigint, number, number, number] }).result) : null;
      const L = s[i * 2 + 1]?.status === "success" ? ((s[i * 2 + 1] as { result: bigint }).result) : null;
      return { p, s0, L };
    });
    const words = base.flatMap(({ p, s0 }, i) => {
      if (!s0) return [];
      const ts = p.key.tickSpacing;
      const lo = wordOf(Math.max(-887272, Number(s0[1]) - WINDOW_TICKS), ts).word;
      const hi = wordOf(Math.min(887272, Number(s0[1]) + WINDOW_TICKS), ts).word;
      const out: { i: number; word: number }[] = [];
      for (let w = lo; w <= hi; w++) out.push({ i, word: w });
      return out;
    });
    const wr = await ctx.reader.multicall(words.map((w) => ({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getTickBitmap", args: [pools[w.i]!.id, w.word] })), b);
    const ticksByPool = new Map<number, number[]>();
    words.forEach((w, k) => {
      if (wr[k]?.status !== "success") return;
      const bm = (wr[k] as { result: bigint }).result;
      if (bm === 0n) return;
      ticksByPool.set(w.i, [...(ticksByPool.get(w.i) ?? []), ...ticksInWord(w.word, bm, pools[w.i]!.key.tickSpacing)]);
    });
    const tickCalls = [...ticksByPool].flatMap(([i, ticks]) => ticks.map((tick) => ({ i, tick })));
    const tr = await ctx.reader.multicall(tickCalls.map((c) => ({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getTickLiquidity", args: [pools[c.i]!.id, c.tick] })), b);
    const nets = new Map<number, Map<number, bigint>>();
    let tickFailures = 0;
    tickCalls.forEach((c, k) => {
      if (tr[k]?.status !== "success") {
        tickFailures++;
        return;
      }
      const m = nets.get(c.i) ?? new Map<number, bigint>();
      m.set(c.tick, (tr[k] as { result: readonly [bigint, bigint] }).result[1]);
      nets.set(c.i, m);
    });
    timingsMs.state = ms(t);

    // Token metadata for identities (decimals/symbol) — registry first, onchain for the rest.
    const tokens = [...new Set(pools.flatMap((p) => [p.key.currency0, p.key.currency1]))];
    const meta = await ctx.reader.multicall(tokens.flatMap((a) => [{ address: a, abi: erc20, functionName: "decimals" }, { address: a, abi: erc20, functionName: "symbol" }]), b);
    const metaOf = new Map(tokens.map((a, i) => [a.toLowerCase(), { decimals: meta[i * 2]?.status === "success" ? Number((meta[i * 2] as { result: number }).result) : null, symbol: meta[i * 2 + 1]?.status === "success" ? String((meta[i * 2 + 1] as { result: string }).result) : null }]));

    t = performance.now();
    const priced = await priceCanonicalAssets(ctx, new Set(tokens.map((a) => assetKey(ctx.chainId, a))));
    timingsMs.prices = ms(t);

    const opportunities: Opportunity[] = [];
    const markets = new Map<string, TradeMarket>();
    const poolMap: Snapshot["pools"] = new Map();
    for (const [i, { p, s0, L }] of base.entries()) {
      const errors: string[] = [];
      if (!s0) errors.push("getSlot0 unreadable");
      if (L === null) errors.push("getLiquidity unreadable");
      let r: { amount0: bigint; amount1: bigint } | null = null;
      if (s0 && L !== null) {
        r = windowReserves({ sqrtPriceX96: s0[0], tick: Number(s0[1]), liquidity: L, lo: Math.max(-887272, Number(s0[1]) - WINDOW_TICKS), hi: Math.min(887272, Number(s0[1]) + WINDOW_TICKS), nets: nets.get(i) ?? new Map() });
      }
      const lpFee = s0 ? Number(s0[3]) : null;
      const checks = [
        { check: UNISWAP_V4.originChecks![0], ok: true, detail: `hooks=0x0, fee=${p.key.fee}, tickSpacing=${p.key.tickSpacing}` },
        { check: UNISWAP_V4.originChecks![1], ok: s0 ? s0[0] > 0n : null, detail: s0 ? `sqrtPriceX96=${s0[0]}` : "unreadable" },
        { check: "StateView lpFee == PoolKey fee (static)", ok: lpFee === null ? null : lpFee === p.key.fee, detail: `lpFee=${lpFee ?? "?"}` },
        { check: "token0 < token1 (Uniswap ordering)", ok: BigInt(p.key.currency0) < BigInt(p.key.currency1), detail: `${p.key.currency0} < ${p.key.currency1}` },
      ];
      const identity: PoolIdentity = {
        pool: p.id as unknown as Address, // a 32-byte pool id, not an address (v4 has no pool contracts)
        token0: p.key.currency0,
        token1: p.key.currency1,
        fee: p.key.fee,
        tickSpacing: p.key.tickSpacing,
        meta: { [p.key.currency0.toLowerCase()]: metaOf.get(p.key.currency0.toLowerCase())!, [p.key.currency1.toLowerCase()]: metaOf.get(p.key.currency1.toLowerCase())! },
        checks,
        readAtBlock: ctx.blockNumber,
      };
      const state: PoolState = { atBlock: { number: ctx.blockNumber, timestamp: ctx.blockTimestamp }, sqrtPriceX96: s0 ? s0[0] : null, tick: s0 ? Number(s0[1]) : null, unlocked: true, liquidity: L, balance0: r?.amount0 ?? null, balance1: r?.amount1 ?? null, errors };
      const discovered: DiscoveredPool = { pool: identity.pool, token0: identity.token0, token1: identity.token1, fee: p.key.fee, tickSpacing: p.key.tickSpacing, createdAtBlock: null, via: "FACTORY_GETPOOL" };
      try {
        const n = normalizePool(
          { discovered, identity, identityBlock: { number: ctx.blockNumber, timestamp: ctx.blockTimestamp }, state },
          {
            chainId: ctx.chainId,
            blockNumber: ctx.blockNumber,
            blockTimestamp: ctx.blockTimestamp,
            nowS,
            generatedAt,
            resolveAsset: (address, symbol, decimals): AssetRef => {
              const a = ctx.registry.get(ctx.chainId, address);
              return a?.canonical ? { key: a.key, chainId: ctx.chainId, address, symbol: a.symbol, decimals: a.decimals, canonical: true, registryType: a.type } : { key: assetKey(ctx.chainId, address), chainId: ctx.chainId, address, symbol: symbol ?? "?", decimals: decimals ?? 18, canonical: false, registryType: null };
            },
            priceOf: priced.priceOf,
            isLookalike: () => false,
            dialect: UNISWAP_V4,
          },
        );
        opportunities.push(...n.opportunities);
        markets.set(n.market.id, n.market);
        poolMap.set(n.market.id, { key: p.key, state, identity });
      } catch (e) {
        issues.push({ scope: `uniswap-v4 ${p.id.slice(0, 10)}…`, message: (e as Error).message, severity: "DEGRADED" });
      }
    }
    if (tickFailures) issues.push({ scope: "uniswap-v4:ticks", message: `${tickFailures} tick reads failed; affected reserves are lower`, severity: "DEGRADED" });
    const snap: Snapshot = { block: ctx.blockNumber, takenAt: this.clock(), opportunities, markets, pools: poolMap, warnings, issues, status: issues.length ? "PARTIAL" : "COMPLETE", timingsMs, generatedAt, nowS };
    this.last = snap;
    return snap;
  }

  async getOpportunities(ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>> {
    const s = await this.snapshot(ctx);
    return { data: s.opportunities, status: s.status, issues: s.issues, warnings: s.warnings, timingsMs: s.timingsMs };
  }

  /**
   * INDICATIVE quote through the official V4Quoter (eth_call only), hop by hop, hookless pools only,
   * at the request's block. Pool identity comes from the latest snapshot; slot0 is read at this block.
   */
  async quoteRoute(route: TradeRoute, amountInRaw: bigint, ctx: AdapterContext): Promise<QuoteResult> {
    if (amountInRaw <= 0n) return { ok: false, reason: "amount must be positive", retryable: false };
    const s = this.last ?? (await this.snapshot(ctx));
    const block = ctx.blockNumber;
    const hops = route.hops.map((h) => ({ h, m: s.markets.get(h.marketId), p: s.pools.get(h.marketId), sqrtPriceX96: null as bigint | null }));
    for (const x of hops) {
      if (!x.m || !x.p) return { ok: false, reason: `market ${x.h.marketId} is not a known Uniswap v4 hookless market`, retryable: false };
      if (!x.m.assets[0].canonical || !x.m.assets[1].canonical) return { ok: false, reason: "quotes are only produced for canonical assets", retryable: false };
      if (!x.m.originVerified || x.m.verificationStatus !== "VERIFIED_ONCHAIN" || x.m.state !== "ACTIVE") return { ok: false, reason: `market ${x.h.marketId} is not verified or not active`, retryable: false };
      if (x.p.key.hooks !== "0x0000000000000000000000000000000000000000") return { ok: false, reason: "hooked pools are never quoted", retryable: false };
    }
    if (s.block === block) for (const x of hops) x.sqrtPriceX96 = x.p!.state.sqrtPriceX96 ?? null;
    else {
      try {
        const r = await ctx.reader.multicall(hops.map((x) => ({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolIdOf(x.p!.key)] })), { blockNumber: block });
        hops.forEach((x, i) => (x.sqrtPriceX96 = r[i]?.status === "success" ? ((r[i] as { result: readonly bigint[] }).result[0] ?? null) : null));
      } catch (e) {
        return { ok: false, reason: `pool state unreadable: ${(e as Error).message?.split("\n")[0] ?? "error"}`, retryable: true };
      }
    }
    if (hops.some((x) => !x.sqrtPriceX96)) return { ok: false, reason: "pool state unreadable", retryable: true };
    const cacheKey = `${route.id}|${amountInRaw}|${block}`;
    const hit = this.quoteCache.get(cacheKey);
    if (hit && this.clock() - hit.at < CACHE_TTL_MS.QUOTE) return hit.result;
    const src: DataSource = { type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract: UNISWAP_V4.quoter, method: "V4Quoter.quoteExactInputSingle (eth_call, per hop)", blockNumber: block, observedAt: ctx.now().toISOString() };
    let amount = amountInRaw;
    let gas = 0n;
    const fees: TradeQuote["fees"] = [];
    const spots: { spot: { num: bigint; den: bigint }; feePpm: number }[] = [];
    try {
      for (const [i, x] of hops.entries()) {
        const k = x.p!.key;
        const zeroForOne = x.h.from.address.toLowerCase() === k.currency0.toLowerCase();
        const r = (await ctx.reader.readContract({ address: UNISWAP_V4.quoter, abi: v4QuoterAbi, functionName: "quoteExactInputSingle", args: [{ poolKey: k, zeroForOne, exactAmount: amount, hookData: "0x" }] }, { blockNumber: block })) as readonly [bigint, bigint];
        fees.push({ hop: i, asset: x.h.from, amount: { raw: hopFee(amount, k.fee), decimals: x.h.from.decimals, display: formatFixed(hopFee(amount, k.fee), x.h.from.decimals) } });
        spots.push({ spot: hopSpotRational(x.sqrtPriceX96!, zeroForOne), feePpm: k.fee });
        gas += r[1];
        amount = r[0];
      }
    } catch (e) {
      const msg = (e as Error).message?.split("\n")[0] ?? "quote failed";
      return { ok: false, reason: `quote unavailable: ${msg}`, retryable: !/revert/i.test(msg) };
    }
    const inDec = route.input.decimals;
    const outDec = route.output.decimals;
    const e = 18 + inDec - outDec;
    const quote: TradeQuote = {
      kind: "INDICATIVE_QUOTE",
      routeId: route.id,
      input: { asset: route.input, raw: amountInRaw, decimals: inDec, display: formatFixed(amountInRaw, inDec) },
      expectedOutput: { asset: route.output, raw: amount, decimals: outDec, display: formatFixed(amount, outDec) },
      effectivePrice: e >= 0 ? (amount * 10n ** BigInt(e)) / amountInRaw : amount / (amountInRaw * 10n ** BigInt(-e)),
      fees,
      priceImpact: priceImpact(amountInRaw, amount, spots),
      gasEstimate: gas,
      quotedAt: ctx.now().toISOString(),
      blockNumber: block,
      freshness: classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), Math.floor(ctx.now().getTime() / 1000)),
      source: src,
      verification: "VERIFIED_ONCHAIN",
      warnings: [warn("INDICATIVE_QUOTE", "Indicative estimate at one block, not a guaranteed output. No minimum output is given.")],
    };
    const result: QuoteResult = { ok: true, quote };
    this.quoteCache.set(cacheKey, { result, at: this.clock() });
    return result;
  }
}
