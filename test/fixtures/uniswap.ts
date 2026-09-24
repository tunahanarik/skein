/**
 * Offline Uniswap v3 world: PoolCreated logs, pool/factory/QuoterV2 behaviour and pool balances.
 * Prices are consistent with the Phase 1 fixture feeds (NVDA $224.41382169, USDG $1.00009,
 * ETH $2,679.2685) so DEX-vs-portfolio divergence is only triggered where a test wants it.
 */
import { getAddress, type Address } from "viem";
import { UNISWAP_READ_CONTRACTS } from "../../src/protocols/uniswap/constants.js";
import { Q192 } from "../../src/protocols/uniswap/math.js";
import { AAPL, NOFEED, NVDA, ONE, SPLT, UNKNOWN_FAKE_USDG, USDG, WETH, type WorldState } from "./world.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
export const FAKE_NVDA = addr(0xbad2); // symbol "NVDA", not in the registry

export function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x && x * x <= n && (x + 1n) * (x + 1n) > n) return x;
    x = y;
  }
}

/** sqrtPriceX96 for a HUMAN price of token0 in token1 given as num/den. */
export function sqrtPriceFor(num: bigint, den: bigint, dec0: number, dec1: number): bigint {
  // raw = price × 10^(dec1 − dec0) ; sqrtP = sqrt(raw × 2^192)
  const scaledNum = dec1 >= dec0 ? num * 10n ** BigInt(dec1 - dec0) : num;
  const scaledDen = dec1 >= dec0 ? den : den * 10n ** BigInt(dec0 - dec1);
  return isqrt((scaledNum * Q192) / scaledDen);
}

export interface FixturePool {
  pool: Address;
  token0: Address;
  token1: Address;
  dec0: number;
  dec1: number;
  fee: number;
  tickSpacing: number;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  balance0: bigint;
  balance1: bigint;
  /** Quote model depth (raw input units) per direction: out = in·spot·(1−fee)·D/(D+in). */
  depth0: bigint;
  depth1: bigint;
  createdAt: bigint;
  factoryOverride?: Address;
  token0Override?: Address;
}

const sorted = (a: Address, b: Address): [Address, Address] => (BigInt(a) < BigInt(b) ? [a, b] : [b, a]);

export function fixtureUniswapPools(): Record<string, FixturePool> {
  const E6 = 10n ** 6n;
  const [n0, n1] = sorted(NVDA, USDG); // NVDA(0x…a001) < USDG
  const [w0, w1] = sorted(WETH, USDG); // WETH(0x0bd7…) < USDG(0x5fc5…)
  const [nw0, nw1] = sorted(NVDA, WETH);
  return {
    nvdaUsdg: {
      pool: addr(0xc001), token0: n0, token1: n1, dec0: 18, dec1: 6, fee: 500, tickSpacing: 10,
      sqrtPriceX96: sqrtPriceFor(22_441_382_169n, 100_009_000n, 18, 6), // NVDA in USDG = 224.41382169 / 1.00009
      liquidity: 10n ** 20n, balance0: 10_000n * ONE, balance1: 2_244_000n * E6,
      depth0: 20_000n * ONE, depth1: 4_500_000n * E6, createdAt: 60_000_001n,
    },
    nvdaWeth: {
      pool: addr(0xc002), token0: nw0, token1: nw1, dec0: 18, dec1: 18, fee: 500, tickSpacing: 10,
      sqrtPriceX96: sqrtPriceFor(22_441_382_169n, 267_926_850_000n, 18, 18), // NVDA in WETH
      liquidity: 10n ** 19n, balance0: 1_000n * ONE, balance1: 83n * ONE,
      depth0: 2_000n * ONE, depth1: 160n * ONE, createdAt: 60_000_002n,
    },
    wethUsdg: {
      pool: addr(0xc003), token0: w0, token1: w1, dec0: 18, dec1: 6, fee: 100, tickSpacing: 1,
      sqrtPriceX96: sqrtPriceFor(267_926_850_000n, 100_009_000n, 18, 6), // WETH in USDG
      liquidity: 10n ** 21n, balance0: 1_000n * ONE, balance1: 2_679_000n * E6,
      depth0: 5_000n * ONE, depth1: 13_000_000n * E6, createdAt: 60_000_003n,
    },
    aaplDust: {
      pool: addr(0xc004), ...(() => { const [a, b] = sorted(AAPL, USDG); return { token0: a, token1: b }; })(), dec0: 18, dec1: 6, fee: 3000, tickSpacing: 60,
      sqrtPriceX96: sqrtPriceFor(33_605_912_874n, 100_009_000n, 18, 6),
      liquidity: 10n ** 9n, balance0: ONE / 10_000n, balance1: 300_000n, // ≈ $0.03 + $0.30
      depth0: ONE / 1000n, depth1: E6, createdAt: 60_000_004n,
    },
    fakeNvda: {
      pool: addr(0xc005), ...(() => { const [a, b] = sorted(FAKE_NVDA, USDG); return { token0: a, token1: b }; })(), dec0: 18, dec1: 6, fee: 500, tickSpacing: 10,
      sqrtPriceX96: sqrtPriceFor(224n, 1n, 18, 6),
      liquidity: 10n ** 20n, balance0: 50_000n * ONE, balance1: 5_000_000n * E6,
      depth0: 100_000n * ONE, depth1: 10_000_000n * E6, createdAt: 60_000_005n,
    },
    // Indexed (the other side is a non-hub canonical token): must never be treated as NVDA / USDG.
    fakeNvdaAapl: {
      pool: addr(0xc009), ...(() => { const [a, b] = sorted(FAKE_NVDA, AAPL); return { token0: a, token1: b }; })(), dec0: 18, dec1: 18, fee: 500, tickSpacing: 10,
      sqrtPriceX96: sqrtPriceFor(2n, 3n, 18, 18), liquidity: 10n ** 20n, balance0: 50_000n * ONE, balance1: 30_000n * ONE,
      depth0: 100_000n * ONE, depth1: 60_000n * ONE, createdAt: 60_000_009n,
    },
    fakeUsdgNvda: {
      pool: addr(0xc00a), ...(() => { const [a, b] = sorted(UNKNOWN_FAKE_USDG, NVDA); return { token0: a, token1: b }; })(), dec0: 18, dec1: 6, fee: 500, tickSpacing: 10,
      sqrtPriceX96: sqrtPriceFor(1n, 1n, 18, 6), liquidity: 10n ** 20n, balance0: 10_000_000n * ONE, balance1: 90_000_000n * E6,
      depth0: 10n ** 30n, depth1: 10n ** 30n, createdAt: 60_000_010n,
    },
    broken: {
      pool: addr(0xc006), ...(() => { const [a, b] = sorted(NVDA, USDG); return { token0: a, token1: b }; })(), dec0: 18, dec1: 6, fee: 3000, tickSpacing: 60,
      sqrtPriceX96: sqrtPriceFor(224n, 1n, 18, 6), liquidity: 10n ** 18n, balance0: 100n * ONE, balance1: 22_400n * E6,
      depth0: ONE, depth1: E6, createdAt: 60_000_006n, factoryOverride: addr(0xfac7),
    },
    zeroLiquidity: {
      pool: addr(0xc007), ...(() => { const [a, b] = sorted(SPLT, USDG); return { token0: a, token1: b }; })(), dec0: 18, dec1: 6, fee: 10000, tickSpacing: 200,
      sqrtPriceX96: sqrtPriceFor(100n, 1n, 18, 6), liquidity: 0n, balance0: 500n * ONE, balance1: 0n,
      depth0: ONE, depth1: E6, createdAt: 60_000_007n,
    },
    unpriced: {
      pool: addr(0xc008), ...(() => { const [a, b] = sorted(NOFEED, USDG); return { token0: a, token1: b }; })(), dec0: 18, dec1: 6, fee: 3000, tickSpacing: 60,
      sqrtPriceX96: sqrtPriceFor(5n, 1n, 18, 6), liquidity: 10n ** 18n, balance0: 1_000n * ONE, balance1: 5_000n * E6,
      depth0: 1_000n * ONE, depth1: 5_000n * E6, createdAt: 60_000_008n,
    },
  };
}

export interface UniswapWorldOptions {
  duplicateLogFor?: string;
  quoteFails?: "revert" | null;
}

/** Install pools into the fake world. Returns a controller for quote behaviour. */
export function installUniswap(world: WorldState, pools: Record<string, FixturePool>, opts: UniswapWorldOptions = {}) {
  const contracts = (world.contracts ??= new Map());
  const logs = (world.logs ??= []);
  const set = (a: Address, h: Record<string, unknown>) => contracts.set(a.toLowerCase(), { ...(contracts.get(a.toLowerCase()) ?? {}), ...h });
  const control = { quoteFails: opts.quoteFails ?? null, quoteCalls: 0 };
  const list = Object.values(pools);
  set(UNISWAP_READ_CONTRACTS.v3Factory, {
    getPool: (a: readonly unknown[]) => {
      const [x, y, fee] = a as [string, string, number];
      const p = list.find((q) => !q.factoryOverride && Number(fee) === q.fee && ((q.token0.toLowerCase() === x.toLowerCase() && q.token1.toLowerCase() === y.toLowerCase()) || (q.token0.toLowerCase() === y.toLowerCase() && q.token1.toLowerCase() === x.toLowerCase())));
      return p ? p.pool : "0x0000000000000000000000000000000000000000";
    },
  });
  set(UNISWAP_READ_CONTRACTS.quoterV2, {
    quoteExactInputSingle: (a: readonly unknown[]) => {
      control.quoteCalls++;
      if (control.quoteFails === "revert") throw new Error("execution reverted: SPL");
      const p0 = a[0] as { tokenIn: string; tokenOut: string; amountIn: bigint; fee: number };
      const p = list.find((q) => Number(p0.fee) === q.fee && !q.factoryOverride && [q.token0, q.token1].map((t) => t.toLowerCase()).includes(p0.tokenIn.toLowerCase()) && [q.token0, q.token1].map((t) => t.toLowerCase()).includes(p0.tokenOut.toLowerCase()));
      if (!p) throw new Error("execution reverted");
      const zeroForOne = p0.tokenIn.toLowerCase() === p.token0.toLowerCase();
      const sq = p.sqrtPriceX96 * p.sqrtPriceX96;
      const inAfterFee = (p0.amountIn * BigInt(1_000_000 - p.fee)) / 1_000_000n;
      const d = zeroForOne ? p.depth0 : p.depth1;
      const spotOut = zeroForOne ? (inAfterFee * sq) / Q192 : (inAfterFee * Q192) / sq;
      const out = (spotOut * d) / (d + p0.amountIn);
      if (out > (zeroForOne ? p.balance1 : p.balance0)) throw new Error("execution reverted: insufficient liquidity");
      return [out, p.sqrtPriceX96, 1, 90_000n];
    },
  });
  let li = 1000;
  for (const [key, p] of Object.entries(pools)) {
    set(p.pool, { factory: p.factoryOverride ?? UNISWAP_READ_CONTRACTS.v3Factory, token0: p.token0Override ?? p.token0, token1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, slot0: [p.sqrtPriceX96, 0, 0, 1, 1, 0, true], liquidity: p.liquidity });
    for (const [t, b] of [[p.token0, p.balance0], [p.token1, p.balance1]] as const) {
      const m = world.balances.get(t.toLowerCase()) ?? new Map<string, bigint>();
      m.set(p.pool.toLowerCase(), b);
      world.balances.set(t.toLowerCase(), m);
    }
    const log = { address: UNISWAP_READ_CONTRACTS.v3Factory, eventName: "PoolCreated", blockNumber: p.createdAt, logIndex: li++, args: { token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: p.tickSpacing, pool: p.pool } };
    logs.push(log);
    if (opts.duplicateLogFor === key) logs.push({ ...log, logIndex: li++ });
  }
  world.meta.set(FAKE_NVDA.toLowerCase(), { symbol: "NVDA", name: "NVIDIA", decimals: 18 });
  world.meta.set(USDG.toLowerCase(), { ...(world.meta.get(USDG.toLowerCase()) ?? {}), symbol: "USDG", decimals: 6 });
  world.meta.set(WETH.toLowerCase(), { symbol: "WETH", decimals: 18 });
  return control;
}
