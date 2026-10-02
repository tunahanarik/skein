/**
 * Fixed-point math for Pendle values. bigint only.
 *
 * Pendle's market stores `lastLnImpliedRate` = ln(1 + impliedAPY), 1e18-scaled (MarketMathCore:
 * the implied rate is kept as its natural log, annualized). Hence impliedAPY = e^x − 1.
 * Verified 2026-09-24 against the Pendle API impliedApy on two markets (agreement to 1e-7,
 * docs/research/pendle.md).
 */
import { WAD } from "@skein/core/lib/fixed";

const SCALE = 10n ** 36n; // internal precision

/** e^(x/1e18) − 1, 1e18-scaled, for 0 ≤ x ≤ 20e18. Taylor series at 1e36 precision; error < 1 wei. */
export function expm1Wad(x: bigint): bigint {
  if (x < 0n) throw new RangeError("expm1Wad: negative input");
  if (x > 20n * WAD) throw new RangeError("expm1Wad: input too large");
  // Range reduction: e^x = (e^(x/2^k))^(2^k) with x/2^k < 0.5.
  let k = 0;
  let y = (x * SCALE) / WAD; // x at 1e36
  while (y > SCALE / 2n) {
    y /= 2n;
    k++;
  }
  // e^y − 1 = y + y²/2! + …
  let term = y;
  let sum = y;
  for (let n = 2n; term !== 0n && n < 60n; n++) {
    term = (term * y) / (SCALE * n);
    sum += term;
  }
  // (1 + s)^2 − 1 = 2s + s², repeated k times
  for (let i = 0; i < k; i++) sum = 2n * sum + (sum * sum) / SCALE;
  return (sum * WAD) / SCALE;
}

/** Market-implied APY from the stored log rate (1e18). */
export function impliedApyFromLnRate(lnRate: bigint): bigint {
  return expm1Wad(lnRate);
}

/** |a − b| / max(|a|,|b|) > pct%? Zero-safe. */
export function differsByMoreThanPct(a: bigint, b: bigint, pct: number): boolean {
  const abs = (v: bigint) => (v < 0n ? -v : v);
  const base = abs(a) > abs(b) ? abs(a) : abs(b);
  if (base === 0n) return false;
  return abs(a - b) * 10_000n > base * BigInt(Math.round(pct * 100));
}
