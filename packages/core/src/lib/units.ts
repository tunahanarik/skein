/**
 * Exact fixed-point helpers. Token amounts and prices stay bigint end to end; conversion to
 * a JS number happens only at the display edge. USD values are carried as integers scaled
 * by 1e18 ("usdE18") so sums over a portfolio do not accumulate float error.
 */

export const USD_DECIMALS = 18;
const TEN = 10n;

export function pow10(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new RangeError(`unsupported decimals: ${decimals}`);
  }
  return TEN ** BigInt(decimals);
}

/** Raw integer amount → exact decimal string ("1234.5"), no float rounding, trailing zeros trimmed. */
export function formatFixed(raw: bigint, decimals: number): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const base = pow10(decimals);
  const whole = abs / base;
  const frac = abs % base;
  let out = whole.toString();
  if (frac !== 0n) out += "." + frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return negative ? "-" + out : out;
}

/**
 * Exact decimal string (e.g. API price "336.38" or multiplier "1.000566080061092436") →
 * integer at `decimals` scale. Extra fractional digits beyond `decimals` are rejected rather
 * than silently truncated, because a truncated multiplier changes a balance.
 */
export function parseFixed(value: string, decimals: number): bigint {
  const s = value.trim();
  const m = /^(-)?([0-9]+)(?:\.([0-9]+))?$/.exec(s);
  if (!m) throw new RangeError(`not a plain decimal number: "${value}"`);
  const [, sign, whole = "0", frac = ""] = m;
  if (frac.length > decimals) {
    if (/[1-9]/.test(frac.slice(decimals))) throw new RangeError(`"${value}" has more than ${decimals} decimals`);
  }
  const fracPadded = frac.slice(0, decimals).padEnd(decimals, "0");
  const raw = BigInt(whole) * pow10(decimals) + (decimals > 0 ? BigInt(fracPadded) : 0n);
  return sign ? -raw : raw;
}

/** Rescale an integer from one decimal scale to another (floors when reducing precision). */
export function rescale(raw: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (toDecimals === fromDecimals) return raw;
  if (toDecimals > fromDecimals) return raw * pow10(toDecimals - fromDecimals);
  return raw / pow10(fromDecimals - toDecimals);
}

/**
 * USD value (scaled 1e18) of `amountRaw` token units at `priceRaw` USD per whole token.
 *   usd = amount/10^amountDecimals × price/10^priceDecimals
 * Floors once at the end, so no intermediate precision is lost.
 */
export function usdValueE18(
  amountRaw: bigint,
  amountDecimals: number,
  priceRaw: bigint,
  priceDecimals: number,
): bigint {
  if (priceRaw < 0n) throw new RangeError("negative price");
  return (amountRaw * priceRaw * pow10(USD_DECIMALS)) / (pow10(amountDecimals) * pow10(priceDecimals));
}

/** Display-edge conversion of a 1e18-scaled USD integer. May lose precision beyond ~15 digits. */
export function usdE18ToNumber(usdE18: bigint): number {
  return Number(formatFixed(usdE18, USD_DECIMALS));
}
