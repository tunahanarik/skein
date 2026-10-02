/**
 * Exact bigint math for Uniswap v3 prices. No floats, no constant-product assumptions.
 *   raw price (token1 base units per token0 base unit) = sqrtPriceX96² / 2^192
 */
import { WAD } from "@skein/core/lib/fixed";

export const Q192 = 1n << 192n;

/** Human price of token0 in token1 (1e18-scaled, floor). */
export function price0In1(sqrtPriceX96: bigint, dec0: number, dec1: number): bigint {
  const sq = sqrtPriceX96 * sqrtPriceX96;
  const e = 18 + dec0 - dec1;
  return e >= 0 ? (sq * 10n ** BigInt(e)) / Q192 : sq / (Q192 * 10n ** BigInt(-e));
}

/** Human price of token1 in token0 (1e18-scaled, floor). Null when the price is zero. */
export function price1In0(sqrtPriceX96: bigint, dec0: number, dec1: number): bigint | null {
  const sq = sqrtPriceX96 * sqrtPriceX96;
  if (sq === 0n) return null;
  const e = 18 + dec1 - dec0;
  return e >= 0 ? (Q192 * 10n ** BigInt(e)) / sq : Q192 / (sq * 10n ** BigInt(-e));
}

/** Spot conversion of one hop as an exact rational (raw out per raw in), before fee. */
export function hopSpotRational(sqrtPriceX96: bigint, zeroForOne: boolean): { num: bigint; den: bigint } {
  const sq = sqrtPriceX96 * sqrtPriceX96;
  return zeroForOne ? { num: sq, den: Q192 } : { num: Q192, den: sq };
}

/**
 * Price impact, fees excluded: 1 − amountOut / (amountIn × Π spot_i × Π(1 − fee_i)), 1e18.
 * `hops` carry the spot rational and fee (ppm) of each pool at the SAME block as the quote.
 * Null if any spot is zero.
 */
export function priceImpact(amountIn: bigint, amountOut: bigint, hops: { spot: { num: bigint; den: bigint }; feePpm: number }[]): bigint | null {
  let num = amountIn;
  let den = 1n;
  for (const h of hops) {
    if (h.spot.num === 0n || h.spot.den === 0n) return null;
    num *= h.spot.num * BigInt(1_000_000 - h.feePpm);
    den *= h.spot.den * 1_000_000n;
  }
  if (num === 0n) return null;
  // ideal = num/den ; impact = (ideal − out) / ideal = (num − out·den) / num
  return ((num - amountOut * den) * WAD) / num;
}

/** Nominal fee of a hop: amountIn × fee / 1e6, rounded up (v3 charges the fee on the input). */
export function hopFee(amountIn: bigint, feePpm: number): bigint {
  const f = BigInt(feePpm);
  return (amountIn * f + 999_999n) / 1_000_000n;
}
