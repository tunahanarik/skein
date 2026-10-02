/**
 * Rate normalization. Protocols report yields differently (Morpho: continuously compounded
 * APY; others: per-second rates or simple APR). Everything is normalized to an APY fraction
 * (0.05 = 5%) and the original form is kept so the UI can say what it was.
 */

export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export type RateKind = "APY" | "APR";
/** VARIABLE: floats with utilization. FIXED: locked for a term. IMPLIED: market-implied (e.g. Pendle PT). */
export type RateBasis = "VARIABLE" | "FIXED" | "IMPLIED";

export interface Rate {
  /** Fraction per year: 0.05 = 5%. */
  value: number;
  kind: RateKind;
  basis: RateBasis;
  /** Averaging window the source used ("instant", "1d", "7d" ...); null when unknown. */
  window: string | null;
}

/** Simple APR → APY with n compounding periods per year; n = Infinity means continuous. */
export function aprToApy(apr: number, periodsPerYear: number): number {
  if (!Number.isFinite(apr)) throw new RangeError("apr must be finite");
  if (periodsPerYear === Number.POSITIVE_INFINITY) return Math.expm1(apr);
  if (!(periodsPerYear >= 1)) throw new RangeError("periodsPerYear must be ≥ 1");
  return Math.expm1(periodsPerYear * Math.log1p(apr / periodsPerYear));
}

export function apyToApr(apy: number, periodsPerYear: number): number {
  if (!(apy > -1)) throw new RangeError("apy must be > -100%");
  if (periodsPerYear === Number.POSITIVE_INFINITY) return Math.log1p(apy);
  return periodsPerYear * Math.expm1(Math.log1p(apy) / periodsPerYear);
}

/**
 * Per-second rate scaled by 1e18 (Morpho IRM `borrowRateView`, many lending protocols) →
 * continuously compounded APY. Morpho compounds with a Taylor expansion of e^x; e^x is the
 * value it approximates.
 */
export function perSecondRateE18ToApy(ratePerSecondE18: bigint): number {
  const perSecond = Number(ratePerSecondE18) / 1e18;
  return Math.expm1(perSecond * SECONDS_PER_YEAR);
}

/**
 * Supply APY of a lending market from its borrow APY, utilization and protocol fee:
 * suppliers earn what borrowers pay on the borrowed share, minus the fee.
 * Expressed on the per-second rates, then compounded back.
 */
export function supplyApyFromBorrow(borrowApy: number, utilization: number, fee: number): number {
  if (utilization < 0 || utilization > 1) throw new RangeError("utilization must be within [0,1]");
  if (fee < 0 || fee > 1) throw new RangeError("fee must be within [0,1]");
  const borrowRate = Math.log1p(borrowApy); // continuous annual rate
  return Math.expm1(borrowRate * utilization * (1 - fee));
}

/** Utilization = borrowed / supplied; null when nothing is supplied (not 0, which would read as "idle"). */
export function utilization(borrowed: bigint, supplied: bigint): number | null {
  if (supplied <= 0n) return null;
  return Number((borrowed * 1_000_000_000n) / supplied) / 1e9;
}

/** Share of a total APY that comes from reward tokens: a reward-dependence risk signal. */
export function rewardShare(totalApy: number, rewardApy: number): number | null {
  if (!(totalApy > 0)) return null;
  return Math.min(Math.max(rewardApy / totalApy, 0), 1);
}
