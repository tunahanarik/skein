/**
 * Uniswap v4 (hookless) math, exact bigint:
 *   poolIdOf           keccak256(abi.encode(PoolKey)) — identity of a pool, computed, never trusted
 *   sqrtRatioAtTick    port of Uniswap's TickMath.getSqrtRatioAtTick (Q64.96)
 *   windowReserves     principal token amounts of the liquidity inside a tick window, from the
 *                      current liquidity and the liquidityNet of initialized ticks (a "tick walk")
 */
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

export const Q96 = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export function hooklessKey(a: Address, b: Address, fee: number, tickSpacing: number): PoolKey {
  const [currency0, currency1] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return { currency0, currency1, fee, tickSpacing, hooks: ZERO };
}

export function poolIdOf(k: PoolKey): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks]));
}

const MAGIC: [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn],
  [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n],
  [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
  [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n],
  [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n],
  [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
  [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** sqrt(1.0001^tick) × 2^96, exactly as Uniswap's TickMath (rounded up to Q96). */
export function sqrtRatioAtTick(tick: number): bigint {
  const abs = Math.abs(tick);
  if (abs > MAX_TICK) throw new Error("tick out of range");
  let ratio = abs & 0x1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  for (const [bit, m] of MAGIC) if (abs & bit) ratio = (ratio * m) >> 128n;
  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/** token0 amount of liquidity L between two sqrt prices (a < b), rounded down. */
export function amount0For(sa: bigint, sb: bigint, L: bigint): bigint {
  if (sa > sb) [sa, sb] = [sb, sa];
  return (((L << 96n) * (sb - sa)) / sb) / sa;
}
/** token1 amount of liquidity L between two sqrt prices (a < b), rounded down. */
export function amount1For(sa: bigint, sb: bigint, L: bigint): bigint {
  if (sa > sb) [sa, sb] = [sb, sa];
  return (L * (sb - sa)) / Q96;
}

/** floor(tick / spacing) → bitmap word index (int16) and bit position, as in Uniswap's TickBitmap. */
export function wordOf(tick: number, spacing: number): { word: number; bit: number } {
  const compressed = Math.floor(tick / spacing);
  return { word: compressed >> 8, bit: ((compressed % 256) + 256) % 256 };
}

/** Ticks whose bit is set in `bitmap` of `word`. */
export function ticksInWord(word: number, bitmap: bigint, spacing: number): number[] {
  const out: number[] = [];
  for (let bit = 0; bit < 256; bit++) if ((bitmap >> BigInt(bit)) & 1n) out.push((word * 256 + bit) * spacing);
  return out;
}

/**
 * Principal token amounts of all liquidity between ticks [lo, hi], given the current sqrt price,
 * current tick, current active liquidity and liquidityNet of every initialized tick in the window.
 * Walks up and down from the current tick. Liquidity outside the window is NOT counted, so the
 * result is a lower bound of the pool's principal reserves.
 */
export function windowReserves(input: { sqrtPriceX96: bigint; tick: number; liquidity: bigint; lo: number; hi: number; nets: ReadonlyMap<number, bigint> }): { amount0: bigint; amount1: bigint } {
  const { sqrtPriceX96: sp, tick, lo, hi } = input;
  const ticks = [...input.nets.keys()].filter((t) => t >= lo && t <= hi).sort((a, b) => a - b);
  let amount0 = 0n;
  let amount1 = 0n;
  // Up: segments [x, y) above the current tick hold token0 (the current segment splits at sp).
  let L = input.liquidity;
  let from = sp;
  for (const t of ticks.filter((x) => x > tick)) {
    const to = sqrtRatioAtTick(t);
    if (L > 0n) amount0 += amount0For(from, to, L);
    L += input.nets.get(t)!;
    from = to;
  }
  if (L > 0n) amount0 += amount0For(from, sqrtRatioAtTick(hi), L);
  // Down: segments below hold token1. Crossing tick t downward removes liquidityNet(t).
  L = input.liquidity;
  let upper = sp;
  for (const t of ticks.filter((x) => x <= tick).reverse()) {
    const at = sqrtRatioAtTick(t);
    if (L > 0n) amount1 += amount1For(at, upper, L);
    L -= input.nets.get(t)!;
    upper = at;
  }
  if (L > 0n) amount1 += amount1For(sqrtRatioAtTick(lo), upper, L);
  return { amount0, amount1 };
}
