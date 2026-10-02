/**
 * Independent check of a Morpho market oracle against the Phase 1 Price Service.
 *
 * Morpho oracle price = loan base units per collateral base unit × 1e36, so the price we expect
 * from independent USD prices is:
 *   expected = Pcoll_usd / Ploan_usd × 10^(36 + loanDecimals − collateralDecimals)
 * The oracles on Robinhood Chain read the same Chainlink feeds as the Price Service, so
 * ratio = oracle / expected matches one of four structures essentially exactly:
 *   1            correct (token feed ÷ loan feed)
 *   m            uiMultiplier applied a second time on top of the token feed (Phase 0 finding)
 *   Ploan        loan asset assumed to be exactly $1 (no loan-feed division)
 *   m × Ploan    both
 * Anything else within 2 % is INCONCLUSIVE (e.g. a different proxy updated at another time);
 * beyond 2 % it DEVIATES. Nothing unexplained is ever labelled CONSISTENT.
 */
import { ORACLE_DEVIATION_WARNING_PCT, ORACLE_MATCH_TOLERANCE_PPM } from "@skein/core/config/freshness";
import { formatFixed18, ratio18, WAD, type Fixed18 } from "@skein/core/lib/fixed";
import { pow10 } from "@skein/core/lib/units";
import type { OracleRisk } from "@skein/core/model/opportunity";
import type { UsdPrice } from "@skein/pricing/types";

export interface OracleCheckInput {
  oraclePrice: bigint | null;
  collateralDecimals: number;
  loanDecimals: number;
  collateralPrice: UsdPrice | null;
  /** True when the collateral price came from a Chainlink feed (exact comparison possible). */
  collateralPriceIsChainlink: boolean;
  loanPrice: UsdPrice | null;
  isStockTokenCollateral: boolean;
  /** Collateral uiMultiplier (Fixed18) when it is a Stock Token. */
  multiplier: bigint | null;
}

const abs = (x: bigint) => (x < 0n ? -x : x);
const TOL = (WAD * BigInt(ORACLE_MATCH_TOLERANCE_PPM)) / 1_000_000n;
const close = (a: bigint, b: bigint) => abs(a - b) <= TOL;

export function expectedOraclePrice(collateral: UsdPrice, loan: UsdPrice, collateralDecimals: number, loanDecimals: number): bigint | null {
  if (loan.raw === 0n) return null;
  // (c.raw / 10^c.dec) / (l.raw / 10^l.dec) × 10^(36 + loanDec − collDec)
  const exp = 36 + loanDecimals - collateralDecimals + loan.decimals - collateral.decimals;
  return exp >= 0 ? (collateral.raw * pow10(exp)) / loan.raw : collateral.raw / (loan.raw * pow10(-exp));
}

type Result = Pick<OracleRisk, "multiplierCheck" | "multiplierCheckDetail" | "loanPegAssumed"> & { ratio: Fixed18 | null };

export function checkOracle(i: OracleCheckInput): Result {
  if (!i.isStockTokenCollateral) return { multiplierCheck: "NOT_APPLICABLE", multiplierCheckDetail: null, loanPegAssumed: null, ratio: null };
  if (i.oraclePrice === null) return { multiplierCheck: "UNCHECKED", multiplierCheckDetail: "oracle price() unreadable", loanPegAssumed: null, ratio: null };
  if (!i.collateralPrice || !i.loanPrice) return { multiplierCheck: "UNCHECKED", multiplierCheckDetail: "collateral or loan asset has no independent price", loanPegAssumed: null, ratio: null };
  const expected = expectedOraclePrice(i.collateralPrice, i.loanPrice, i.collateralDecimals, i.loanDecimals);
  if (!expected) return { multiplierCheck: "UNCHECKED", multiplierCheckDetail: "cannot compute expected price", loanPegAssumed: null, ratio: null };
  const ratio = ratio18(i.oraclePrice, expected)!;
  const m = i.multiplier ?? WAD;
  const pl = (i.loanPrice.raw * WAD) / pow10(i.loanPrice.decimals); // loan USD price, Fixed18
  const detail = `oracle/expected = ${formatFixed18(ratio)}, uiMultiplier = ${formatFixed18(m)}, loan USD = ${formatFixed18(pl)}`;
  const beyond = abs(ratio - WAD) * 100n > BigInt(ORACLE_DEVIATION_WARNING_PCT) * WAD;
  if (!i.collateralPriceIsChainlink) {
    // Fallback prices (quote mid) are too noisy for a structural match; only gross deviation is judged.
    return beyond
      ? { multiplierCheck: "DEVIATES", multiplierCheckDetail: `${detail} (vs non-Chainlink price)`, loanPegAssumed: null, ratio }
      : { multiplierCheck: "UNCHECKED", multiplierCheckDetail: `${detail}; structural check needs a Chainlink collateral price`, loanPegAssumed: null, ratio };
  }
  const mDistinct = !close(m, WAD);
  const plDistinct = !close(pl, WAD);
  const mPl = (m * pl) / WAD;
  // Most specific explanation first.
  if (mDistinct && close(ratio, m)) return { multiplierCheck: "DOUBLE_APPLIED", multiplierCheckDetail: `${detail}: oracle = token price × uiMultiplier (multiplier applied twice)`, loanPegAssumed: false, ratio };
  if (mDistinct && plDistinct && close(ratio, mPl)) return { multiplierCheck: "DOUBLE_APPLIED", multiplierCheckDetail: `${detail}: multiplier applied twice AND loan asset assumed $1`, loanPegAssumed: true, ratio };
  if (close(ratio, WAD)) {
    return mDistinct
      ? { multiplierCheck: "CONSISTENT", multiplierCheckDetail: detail, loanPegAssumed: plDistinct ? false : null, ratio }
      : { multiplierCheck: "NOT_DETECTABLE", multiplierCheckDetail: `${detail}; price consistent, but uiMultiplier = 1 so a double application would not show`, loanPegAssumed: plDistinct ? false : null, ratio };
  }
  if (plDistinct && close(ratio, pl)) {
    return { multiplierCheck: mDistinct ? "CONSISTENT" : "NOT_DETECTABLE", multiplierCheckDetail: `${detail}: oracle values the loan asset at exactly $1`, loanPegAssumed: true, ratio };
  }
  if (beyond) return { multiplierCheck: "DEVIATES", multiplierCheckDetail: detail, loanPegAssumed: null, ratio };
  return { multiplierCheck: "INCONCLUSIVE", multiplierCheckDetail: `${detail}; matches no known structure within ${ORACLE_MATCH_TOLERANCE_PPM} ppm (e.g. a different feed proxy)`, loanPegAssumed: null, ratio };
}
