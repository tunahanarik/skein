/**
 * Stock Token (ERC-20 + ERC-8056 "Scaled UI Amount") balance and valuation math.
 *
 * Facts this relies on (see docs/research/stock-tokens.md for evidence):
 * - balanceOf()/totalSupply() never change on corporate actions; tokens do not rebase.
 * - uiMultiplier() is fixed-point 1e18 (1.0 = 1e18). Dividends are reinvested and splits
 *   are applied by raising the multiplier.
 * - share-equivalent units = raw balance × uiMultiplier ÷ 1e18 (= balanceOfUI()).
 * - Chainlink Stock Token feeds price ONE TOKEN (underlying × multiplier already applied).
 * - Robinhood GET /rhj/prices bid/ask are the RAW UNDERLYING share price (not multiplied).
 *
 * The two price kinds are separate types so a caller cannot multiply twice or not at all.
 */
import { parseFixed, pow10, usdValueE18 } from "./units.js";

export const MULTIPLIER_DECIMALS = 18;
export const ONE_MULTIPLIER = 10n ** 18n;

/** USD price of one whole token, multiplier already included (Chainlink Stock Token feed). */
export interface TokenPrice {
  kind: "TOKEN_PRICE";
  raw: bigint;
  decimals: number;
}

/** USD price of one underlying share, multiplier NOT included (Robinhood /rhj/prices). */
export interface UnderlyingPrice {
  kind: "UNDERLYING_PRICE";
  raw: bigint;
  decimals: number;
}

export type StockPrice = TokenPrice | UnderlyingPrice;

function assertMultiplier(multiplierE18: bigint): void {
  // 0 would zero every balance; a real multiplier is always positive.
  if (multiplierE18 <= 0n) throw new RangeError(`invalid uiMultiplier ${multiplierE18}`);
}

/** Share-equivalent raw units: what balanceOfUI() returns. */
export function shareEquivalentRaw(rawBalance: bigint, multiplierE18: bigint): bigint {
  assertMultiplier(multiplierE18);
  return (rawBalance * multiplierE18) / ONE_MULTIPLIER;
}

/** Underlying share price → price of one token (apply the multiplier once). */
export function tokenPriceFromUnderlying(p: UnderlyingPrice, multiplierE18: bigint): TokenPrice {
  assertMultiplier(multiplierE18);
  return { kind: "TOKEN_PRICE", raw: (p.raw * multiplierE18) / ONE_MULTIPLIER, decimals: p.decimals };
}

/** Token price → implied underlying share price (per Robinhood docs: feed × 1e18 / uiMultiplier). */
export function underlyingFromTokenPrice(p: TokenPrice, multiplierE18: bigint): UnderlyingPrice {
  assertMultiplier(multiplierE18);
  return { kind: "UNDERLYING_PRICE", raw: (p.raw * ONE_MULTIPLIER) / multiplierE18, decimals: p.decimals };
}

/**
 * USD value (1e18-scaled) of a raw Stock Token balance.
 * - TOKEN_PRICE:      raw × tokenPrice                  (multiplier is inside the price)
 * - UNDERLYING_PRICE: raw × multiplier/1e18 × sharePrice (multiplier applied here, once)
 */
export function stockTokenUsdE18(
  rawBalance: bigint,
  tokenDecimals: number,
  price: StockPrice,
  multiplierE18: bigint,
): bigint {
  assertMultiplier(multiplierE18);
  if (price.kind === "TOKEN_PRICE") {
    return usdValueE18(rawBalance, tokenDecimals, price.raw, price.decimals);
  }
  // multiply before dividing so the multiplier's precision is kept
  return (
    usdValueE18(rawBalance * multiplierE18, tokenDecimals, price.raw, price.decimals) / ONE_MULTIPLIER
  );
}

/**
 * Mid price from a Robinhood /rhj/prices quote. The API uses "0" for "unavailable", so a zero
 * or missing side yields null instead of a fake price. Result is an UNDERLYING price.
 */
export function underlyingMidFromQuote(bid: string, ask: string, decimals = 18): UnderlyingPrice | null {
  let b: bigint;
  let a: bigint;
  try {
    b = parseFixed(bid, decimals);
    a = parseFixed(ask, decimals);
  } catch {
    return null;
  }
  if (b <= 0n || a <= 0n || a < b) return null; // crossed or empty book: no trustworthy mid
  return { kind: "UNDERLYING_PRICE", raw: (a + b) / 2n, decimals };
}

/** Parse the API's decimal multiplier string ("1.000566080061092436") into 1e18 fixed point. */
export function parseMultiplier(value: string): bigint {
  const m = parseFixed(value, MULTIPLIER_DECIMALS);
  assertMultiplier(m);
  return m;
}

export interface MultiplierSnapshot {
  current: bigint;
  /** Scheduled next multiplier, if one is pending. */
  pending?: bigint;
  /** Unix seconds at which `pending` takes effect. */
  pendingEffectiveAt?: number;
}

/**
 * Multiplier that applies at `nowSeconds`, from a CACHED snapshot (e.g. the /rhj/assets
 * response). A scheduled change becomes current once its effective time has passed, so a
 * snapshot fetched before the switch is not used past it. A live uiMultiplier() read at the
 * valuation block is always preferred over this.
 */
export function effectiveMultiplier(s: MultiplierSnapshot, nowSeconds: number): bigint {
  assertMultiplier(s.current);
  if (s.pending !== undefined && s.pendingEffectiveAt !== undefined && nowSeconds >= s.pendingEffectiveAt) {
    assertMultiplier(s.pending);
    return s.pending;
  }
  return s.current;
}

/**
 * Relative gap between two token prices at a common scale, as a fraction (0.01 = 1%).
 * Used to cross-check the Chainlink feed against the Robinhood quote before trusting either.
 */
export function relativeDeviation(a: TokenPrice, b: TokenPrice): number {
  const scale = Math.max(a.decimals, b.decimals);
  const ar = a.raw * pow10(scale - a.decimals);
  const br = b.raw * pow10(scale - b.decimals);
  if (br === 0n) return Number.POSITIVE_INFINITY;
  const diff = ar > br ? ar - br : br - ar;
  // keep 1e-9 resolution without going through float for the big integers
  return Number((diff * 1_000_000_000n) / br) / 1e9;
}
