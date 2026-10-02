/**
 * Fixed-point (1e18) helpers for rates and ratios. Financial arithmetic stays in bigint;
 * protocol-supplied floats (e.g. Morpho API APYs) are converted ONCE, from their exact decimal
 * representation, and never used in further float math.
 */
import { formatFixed, pow10 } from "./units.js";

export const WAD = 10n ** 18n;

/** Fraction scaled by 1e18 (0.05 = 5e16). */
export type Fixed18 = bigint;

/**
 * JS number (as returned by an API) → Fixed18, floored at 18 decimals. Uses the number's own
 * shortest decimal representation (Number#toString), expanding exponent notation exactly.
 * Rejects NaN/Infinity.
 */
export function fixed18FromNumber(n: number): Fixed18 {
  if (!Number.isFinite(n)) throw new RangeError(`not a finite number: ${n}`);
  const s = n.toString();
  const m = /^(-)?(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/i.exec(s);
  if (!m) throw new RangeError(`unexpected number format: ${s}`);
  const [, sign, int, frac = "", exp = "0"] = m;
  const digits = (int! + frac).replace(/^0+(?=\d)/, "");
  const scale = frac.length - Number(exp); // value = digits × 10^-scale
  let v: bigint;
  if (scale <= 18) v = BigInt(digits) * pow10(18 - scale);
  else v = BigInt(digits) / pow10(scale - 18); // floor extra precision
  return sign ? -v : v;
}

/** Decimal string of a Fixed18 ("0.045389"). */
export function formatFixed18(v: Fixed18): string {
  return formatFixed(v, 18);
}

/** Percent string with fixed decimals for display ("4.54%"), floored. */
export function formatPercent(v: Fixed18, decimals = 2): string {
  const scaled = (v * 100n * pow10(decimals)) / WAD;
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  const s = abs.toString().padStart(decimals + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, s.length - decimals)}${decimals ? "." + s.slice(-decimals) : ""}%`;
}

/** a × b / c with floor rounding (Morpho mulDivDown). */
export function mulDivDown(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new RangeError("division by zero");
  return (a * b) / c;
}

/** a × b / c with ceiling rounding (Morpho mulDivUp), for non-negative inputs. */
export function mulDivUp(a: bigint, b: bigint, c: bigint): bigint {
  if (c === 0n) throw new RangeError("division by zero");
  return (a * b + (c - 1n)) / c;
}

/** Morpho wMulDown: x × y / 1e18. */
export function wMulDown(x: bigint, y: bigint): bigint {
  return mulDivDown(x, y, WAD);
}

/** Ratio num/den as Fixed18 (floor); null when den is 0. */
export function ratio18(num: bigint, den: bigint): Fixed18 | null {
  return den === 0n ? null : (num * WAD) / den;
}
