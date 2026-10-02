/**
 * Onchain reads for Uniswap-v3-style pools (dialects: Uniswap v3, Ramses CL), all through the
 * ChainReader (pinned block, multicall).
 *
 *   discovery  PoolCreated logs of the official v3 factory, filtered by indexed token topics
 *   identity   pool.factory/token0/token1/fee/tickSpacing + factory.getPool(...) round trip
 *   state      slot0, liquidity, token balances held by the pool — every run
 *   quote      QuoterV2.quoteExactInputSingle via eth_call (never sent), per hop
 */
import type { Address } from "viem";
import type { CallResult, ChainReader, ContractCall } from "@skein/chain/reader";
import { sameAddress, ZERO_ADDRESS } from "@skein/core/lib/validation";
import { erc20Abi, poolCreatedEvent, quoterV2Abi, quoterV2TickSpacingAbi, UNISWAP_V3, v3FactoryAbi, v3FactoryTickSpacingAbi, v3PoolAbi, type V3Dialect } from "./constants.js";

/** The factory's getPool key for a pool: its fee (FEE dialect) or its tickSpacing. */
const poolKeyOf = (d: V3Dialect, p: { fee: number; tickSpacing: number }) => (d.poolKey === "FEE" ? p.fee : p.tickSpacing);
const factoryAbiOf = (d: V3Dialect) => (d.poolKey === "FEE" ? v3FactoryAbi : v3FactoryTickSpacingAbi);

export interface DiscoveredPool {
  pool: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  /** Block of the PoolCreated event; null when found by the factory getPool sweep. */
  createdAtBlock: bigint | null;
  /** EVENT = factory PoolCreated log; FACTORY_GETPOOL = factory.getPool(token, hub, fee) sweep. */
  via: "EVENT" | "FACTORY_GETPOOL";
}

/**
 * Which pools we index: any pool with at least one non-hub canonical token (e.g. a Stock Token),
 * plus pools between two routing hubs (USDG/WETH). Hub-vs-arbitrary-token pools are NOT indexed:
 * USDG alone is paired in ~6,000 v3 pools (2026-09-24), almost all launchpad tokens that could
 * never pass default TRADE eligibility (docs/protocols/uniswap-adapter.md).
 */
export function isIndexedPair(token0: Address, token1: Address, nonHub: ReadonlySet<string>, hubs: ReadonlySet<string>): boolean {
  const a = token0.toLowerCase();
  const b = token1.toLowerCase();
  return nonHub.has(a) || nonHub.has(b) || (hubs.has(a) && hubs.has(b));
}

const val = <T>(r: CallResult | undefined): T | null => (r?.status === "success" ? (r.result as T) : null);

/** Topic OR-sets larger than this time out on the public RPC (measured: 10 ok, 50 timed out). */
export const DISCOVERY_TOPIC_CHUNK = 10;

function toPools(logs: { args: Record<string, unknown>; blockNumber: bigint }[]): DiscoveredPool[] {
  const out = new Map<string, DiscoveredPool>();
  for (const l of logs) {
    const pool = l.args.pool as Address;
    if (out.has(pool.toLowerCase())) continue; // duplicate logs for one pool are collapsed
    out.set(pool.toLowerCase(), { pool, token0: l.args.token0 as Address, token1: l.args.token1 as Address, fee: Number(l.args.fee), tickSpacing: Number(l.args.tickSpacing), createdAtBlock: l.blockNumber, via: "EVENT" });
  }
  return [...out.values()];
}

/** One unit of the resumable cold event scan (a topic-filtered full-range query). */
export interface ScanTask {
  key: string;
  args: Record<string, unknown>;
}

/**
 * Task keys: `token0:<start>:<count>` / `token1:<start>:<count>` (a slice of the non-hub token
 * list) and `hubs`. Keys are resolved against the CURRENT token list; the token-set hash in the
 * store guarantees the list is the one the keys were made for.
 */
export function coldScanTaskKeys(nonHubCount: number, hubs: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < nonHubCount; i += DISCOVERY_TOPIC_CHUNK) {
    const n = Math.min(DISCOVERY_TOPIC_CHUNK, nonHubCount - i);
    keys.push(`token0:${i}:${n}`, `token1:${i}:${n}`);
  }
  if (hubs) keys.push("hubs");
  return keys;
}

export function resolveScanTask(key: string, nonHub: readonly Address[], hubs: readonly Address[]): ScanTask | null {
  if (key === "hubs") return { key, args: { token0: hubs, token1: hubs } };
  const m = /^(token[01]):(\d+):(\d+)$/.exec(key);
  if (!m) return null;
  const slice = nonHub.slice(Number(m[2]), Number(m[2]) + Number(m[3]));
  return slice.length ? { key, args: { [m[1]!]: slice } } : null;
}

/** Halves of a token-slice task (for a timed-out topic set); null when it is a single token. */
export function splitScanTaskKey(key: string): [string, string] | null {
  const m = /^(token[01]):(\d+):(\d+)$/.exec(key);
  if (!m || Number(m[3]) <= 1) return null;
  const start = Number(m[2]);
  const n = Number(m[3]);
  const h = Math.ceil(n / 2);
  return [`${m[1]}:${start}:${h}`, `${m[1]}:${start + h}:${n - h}`];
}

/**
 * One task over the full range. Multi-token sets are NOT range-bisected (they are split by tokens
 * instead, see LogQuery.noRangeSplit); a single-token set can only be helped by range bisection
 * (e.g. a token with > 10,000 pools), so it keeps it.
 */
export async function runScanTask(reader: ChainReader, task: ScanTask, fromBlock: bigint, toBlock: bigint, d: V3Dialect = UNISWAP_V3): Promise<DiscoveredPool[]> {
  if (toBlock < fromBlock) return [];
  const setSize = Math.max(...Object.values(task.args).map((v) => (Array.isArray(v) ? v.length : 1)));
  return toPools(await reader.getLogs({ address: d.factory, event: poolCreatedEvent, fromBlock, toBlock, args: task.args, noRangeSplit: setSize > 1 }));
}

/**
 * Fast factory sweep: factory.getPool(token, hub, fee) for every non-hub canonical token × hub ×
 * enabled fee tier, plus hub × hub. The factory's own registry, answered in a few multicalls, so the
 * pools that can matter for default TRADE results are known immediately — even while the resumable
 * event scan (which also finds token-vs-token pools) is still running on a rate-limited RPC.
 */
export async function sweepFactoryPools(reader: ChainReader, nonHub: readonly Address[], hubs: readonly Address[], blockNumber: bigint, d: V3Dialect = UNISWAP_V3): Promise<DiscoveredPool[]> {
  const fees = Object.keys(d.tiers).map(Number); // fee tiers (FEE) or tick spacings (TICK_SPACING)
  const pairs: [Address, Address][] = [];
  for (const t of nonHub) for (const h of hubs) pairs.push([t, h]);
  for (let i = 0; i < hubs.length; i++) for (let j = i + 1; j < hubs.length; j++) pairs.push([hubs[i]!, hubs[j]!]);
  const combos = pairs.flatMap(([a, b]) => fees.map((fee) => ({ a, b, fee })));
  const r = await reader.multicall(combos.map((c) => ({ address: d.factory, abi: factoryAbiOf(d), functionName: "getPool", args: [c.a, c.b, c.fee] })), { blockNumber });
  const out: DiscoveredPool[] = [];
  combos.forEach((c, i) => {
    const pool = val<Address>(r[i]);
    if (!pool || sameAddress(pool, ZERO_ADDRESS)) return;
    const [token0, token1] = BigInt(c.a) < BigInt(c.b) ? [c.a, c.b] : [c.b, c.a];
    // FEE: key = fee. TICK_SPACING: key = tickSpacing; fee = the tier's initial fee until identity reads fee().
    out.push({ pool, token0, token1, fee: d.poolKey === "FEE" ? c.fee : d.tiers[c.fee]!, tickSpacing: d.poolKey === "FEE" ? d.tiers[c.fee]! : c.fee, createdAtBlock: null, via: "FACTORY_GETPOOL" });
  });
  return out;
}

/** Incremental scan of a (short) new range: unfiltered query, filtered client-side by address. */
export async function discoverPoolsIncremental(reader: ChainReader, nonHub: ReadonlySet<string>, hubs: ReadonlySet<string>, fromBlock: bigint, toBlock: bigint, d: V3Dialect = UNISWAP_V3): Promise<DiscoveredPool[]> {
  if (toBlock < fromBlock) return [];
  const logs = await reader.getLogs({ address: d.factory, event: poolCreatedEvent, fromBlock, toBlock });
  return toPools(logs.filter((l) => isIndexedPair(l.args.token0 as Address, l.args.token1 as Address, nonHub, hubs)));
}

export interface IdentityCheck {
  check: string;
  ok: boolean | null;
  detail: string;
}

export interface PoolIdentity {
  pool: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number;
  meta: Record<string, { decimals: number | null; symbol: string | null }>;
  checks: IdentityCheck[];
  readAtBlock: bigint;
}

export async function readPoolIdentities(reader: ChainReader, pools: readonly DiscoveredPool[], blockNumber: bigint, d: V3Dialect = UNISWAP_V3): Promise<Map<string, PoolIdentity>> {
  const out = new Map<string, PoolIdentity>();
  if (!pools.length) return out;
  const PER = 6;
  const r = await reader.multicall(
    pools.flatMap((p): ContractCall[] => [
      { address: p.pool, abi: v3PoolAbi, functionName: "factory" },
      { address: p.pool, abi: v3PoolAbi, functionName: "token0" },
      { address: p.pool, abi: v3PoolAbi, functionName: "token1" },
      { address: p.pool, abi: v3PoolAbi, functionName: "fee" },
      { address: p.pool, abi: v3PoolAbi, functionName: "tickSpacing" },
      { address: d.factory, abi: factoryAbiOf(d), functionName: "getPool", args: [p.token0, p.token1, poolKeyOf(d, p)] },
    ]),
    { blockNumber },
  );
  const tokens = new Map<string, Address>();
  for (const p of pools) for (const t of [p.token0, p.token1]) tokens.set(t.toLowerCase(), t);
  const tl = [...tokens.values()];
  const m = await reader.multicall(tl.flatMap((t): ContractCall[] => [{ address: t, abi: erc20Abi, functionName: "decimals" }, { address: t, abi: erc20Abi, functionName: "symbol" }]), { blockNumber });
  const meta = new Map(tl.map((t, i) => [t.toLowerCase(), { decimals: val<number>(m[i * 2]), symbol: val<string>(m[i * 2 + 1]) }]));
  pools.forEach((p, i) => {
    const o = i * PER;
    const factory = val<Address>(r[o]);
    const t0 = val<Address>(r[o + 1]);
    const t1 = val<Address>(r[o + 2]);
    const fee = val<number>(r[o + 3]);
    const ts = val<number>(r[o + 4]);
    const viaFactory = val<Address>(r[o + 5]);
    const checks: IdentityCheck[] = [];
    const chk = (check: string, ok: boolean | null, detail: string) => checks.push({ check, ok, detail });
    const eq = (a: Address | null, b: Address) => (a === null ? null : sameAddress(a, b));
    chk(`pool.factory() == ${d.factoryLabel}`, eq(factory, d.factory), `factory=${factory ?? "unreadable (no code?)"}`);
    chk(`factory.getPool(token0, token1, ${d.poolKey === "FEE" ? "fee" : "tickSpacing"}) == pool`, viaFactory === null ? null : !sameAddress(viaFactory, ZERO_ADDRESS) && sameAddress(viaFactory, p.pool), `getPool=${viaFactory ?? "unreadable"}`);
    chk("pool.token0() == discovered token0", eq(t0, p.token0), `token0=${t0 ?? "unreadable"}`);
    chk("pool.token1() == discovered token1", eq(t1, p.token1), `token1=${t1 ?? "unreadable"}`);
    // Static-fee dialects: fee() must equal the discovered tier. Dynamic-fee dialects: fee() must be readable and sane.
    if (d.dynamicFee) chk("pool.fee() readable (dynamic fee)", fee === null ? null : Number(fee) > 0 && Number(fee) < 1_000_000, `fee=${fee ?? "unreadable"}`);
    else chk("pool.fee() == discovered fee", fee === null ? null : Number(fee) === p.fee, `fee=${fee ?? "unreadable"}`);
    chk("token0 < token1 (Uniswap ordering)", BigInt(p.token0) < BigInt(p.token1), `${p.token0} < ${p.token1}`);
    if (d.poolKey === "FEE") {
      const expectedTs = d.tiers[p.fee];
      chk("tickSpacing matches the fee tier", ts === null ? null : expectedTs !== undefined && Number(ts) === expectedTs && p.tickSpacing === expectedTs, `tickSpacing=${ts ?? "?"} expected ${expectedTs ?? "unknown tier"}`);
    } else {
      chk("tickSpacing is an enabled spacing and matches discovery", ts === null ? null : d.tiers[Number(ts)] !== undefined && Number(ts) === p.tickSpacing, `tickSpacing=${ts ?? "?"} discovered ${p.tickSpacing}`);
    }
    out.set(p.pool.toLowerCase(), {
      pool: p.pool,
      token0: p.token0,
      token1: p.token1,
      fee: d.dynamicFee && fee !== null ? Number(fee) : p.fee,
      tickSpacing: p.tickSpacing,
      meta: { [p.token0.toLowerCase()]: meta.get(p.token0.toLowerCase())!, [p.token1.toLowerCase()]: meta.get(p.token1.toLowerCase())! },
      checks,
      readAtBlock: blockNumber,
    });
  });
  return out;
}

export interface PoolState {
  /** The block this state was read at (states of secondary pools may be reused for a while). */
  atBlock: { number: bigint; timestamp: bigint };
  sqrtPriceX96: bigint | null;
  tick: number | null;
  unlocked: boolean | null;
  liquidity: bigint | null;
  balance0: bigint | null;
  balance1: bigint | null;
  /** Dynamic-fee dialects: pool.fee() at this block (ppm). */
  fee?: number | null;
  errors: string[];
}

export async function readPoolStates(reader: ChainReader, ids: readonly PoolIdentity[], blockNumber: bigint, blockTimestamp: bigint, d: V3Dialect = UNISWAP_V3): Promise<Map<string, PoolState>> {
  const PER = d.dynamicFee ? 5 : 4;
  const r = await reader.multicall(
    ids.flatMap((p): ContractCall[] => [
      { address: p.pool, abi: v3PoolAbi, functionName: "slot0" },
      { address: p.pool, abi: v3PoolAbi, functionName: "liquidity" },
      { address: p.token0, abi: erc20Abi, functionName: "balanceOf", args: [p.pool] },
      { address: p.token1, abi: erc20Abi, functionName: "balanceOf", args: [p.pool] },
      ...(d.dynamicFee ? [{ address: p.pool, abi: v3PoolAbi, functionName: "fee" } as ContractCall] : []),
    ]),
    { blockNumber },
  );
  const out = new Map<string, PoolState>();
  ids.forEach((p, i) => {
    const o = i * PER;
    const errors: string[] = [];
    const g = <T>(k: number, label: string): T | null => {
      const x = r[o + k];
      if (x?.status === "success") return x.result as T;
      errors.push(`${label}: ${x?.status === "failure" ? x.error : "missing"}`);
      return null;
    };
    const s0 = g<readonly [bigint, number, number, number, number, number, boolean]>(0, "slot0");
    out.set(p.pool.toLowerCase(), {
      atBlock: { number: blockNumber, timestamp: blockTimestamp },
      sqrtPriceX96: s0 ? s0[0] : null,
      tick: s0 ? Number(s0[1]) : null,
      unlocked: s0 ? s0[6] : null,
      liquidity: g<bigint>(1, "liquidity"),
      balance0: g<bigint>(2, "token0.balanceOf(pool)"),
      balance1: g<bigint>(3, "token1.balanceOf(pool)"),
      ...(d.dynamicFee ? { fee: dynFee(g<number>(4, "fee")) } : {}),
      errors,
    });
  });
  return out;
}

const dynFee = (f: number | null) => (f === null ? null : Number(f));

export interface SingleQuote {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
}

/** One-hop exact-input quote through QuoterV2 (eth_call only). */
/** `key` is the pool's fee (FEE dialect) or tickSpacing (TICK_SPACING dialect). */
export async function quoteExactInputSingle(reader: ChainReader, tokenIn: Address, tokenOut: Address, key: number, amountIn: bigint, blockNumber: bigint, d: V3Dialect = UNISWAP_V3): Promise<SingleQuote> {
  const call: ContractCall =
    d.poolKey === "FEE"
      ? { address: d.quoter, abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, fee: key, sqrtPriceLimitX96: 0n }] }
      : { address: d.quoter, abi: quoterV2TickSpacingAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn, tokenOut, amountIn, tickSpacing: key, sqrtPriceLimitX96: 0n }] };
  const r = (await reader.readContract(call, { blockNumber })) as readonly [bigint, bigint, number, bigint];
  return { amountOut: r[0], sqrtPriceX96After: r[1], initializedTicksCrossed: Number(r[2]), gasEstimate: r[3] };
}
