/**
 * Category-specific deterministic ordering (docs/product-ranking.md). There is no universal
 * score and no cross-category ranking: each comparator orders ONE product subcategory for ONE
 * asset, only on metrics whose semantics are compatible (same type, same side, same unit).
 * Every comparator ends with `cardId` so ties are deterministic. Nothing is labelled "best".
 */
import type { MetricView, ProductCard, ProductSubcategory, RankingFactors, Usability } from "./types.js";

const USABILITY_ORDER: Record<Usability, number> = { ACTIONABLE: 0, LIMITED: 1, INFORMATIONAL: 2, HIDDEN_BY_DEFAULT: 3, UNAVAILABLE: 4 };

type Cmp = (a: ProductCard, b: ProductCard) => number;
const byUsability: Cmp = (a, b) => USABILITY_ORDER[a.usability.status] - USABILITY_ORDER[b.usability.status];
const byId: Cmp = (a, b) => a.cardId.localeCompare(b.cardId);
/** Descending bigint; null (unknown) always last — never treated as 0. */
const desc = (x: bigint | null | undefined, y: bigint | null | undefined) => (x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : x === y ? 0 : x > y ? -1 : 1);
const asc = (x: bigint | null | undefined, y: bigint | null | undefined) => (x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : x === y ? 0 : x < y ? -1 : 1);
const metric = (c: ProductCard, t: MetricView["type"]) => (c.headline?.type === t ? c.headline : (c.metrics.find((m) => m.type === t) ?? null));
/** Rate comparison only when both rates share type, side and unit; otherwise "not comparable" (0). */
const rateDesc = (t: MetricView["type"]): Cmp => (a, b) => {
  const x = metric(a, t);
  const y = metric(b, t);
  if (x && y && (x.side !== y.side || x.unit !== y.unit)) return 0;
  return desc(x?.value, y?.value);
};
const rateAsc = (t: MetricView["type"]): Cmp => (a, b) => {
  const x = metric(a, t);
  const y = metric(b, t);
  if (x && y && (x.side !== y.side || x.unit !== y.unit)) return 0;
  return asc(x?.value, y?.value);
};
const liquidityDesc: Cmp = (a, b) => desc(a.liquidity?.usd?.e18, b.liquidity?.usd?.e18);
const tvlDesc: Cmp = (a, b) => desc(a.tvlUsd?.e18, b.tvlUsd?.e18);
const maturityKnown: Cmp = (a, b) => Number(a.maturity === null) - Number(b.maturity === null);
const maturityAsc: Cmp = (a, b) => (a.maturity ?? "~").localeCompare(b.maturity ?? "~");
const counterSymbol: Cmp = (a, b) => (a.counterAsset?.symbol ?? "").localeCompare(b.counterAsset?.symbol ?? "") || (a.counterAsset?.key ?? "").localeCompare(b.counterAsset?.key ?? "");
const lltvDesc: Cmp = (a, b) => desc(a.lltv, b.lltv);
const routeVerified: Cmp = (a, b) => Number(!(a.trade?.route.allVerified ?? false)) - Number(!(b.trade?.route.allVerified ?? false));
const hopsAsc: Cmp = (a, b) => (a.trade?.route.path.length ?? 9) - (b.trade?.route.path.length ?? 9);
const feeAsc: Cmp = (a, b) => (a.trade?.route.combinedFeePpm ?? Number.MAX_SAFE_INTEGER) - (b.trade?.route.combinedFeePpm ?? Number.MAX_SAFE_INTEGER);
const outputDesc: Cmp = (a, b) => desc(a.trade?.quote?.expectedOutput.raw, b.trade?.quote?.expectedOutput.raw);
const impactAsc: Cmp = (a, b) => asc(a.trade?.quote?.priceImpact, b.trade?.quote?.priceImpact);
const quoteFresher: Cmp = (a, b) => desc(a.trade?.quote?.blockNumber, b.trade?.quote?.blockNumber);

export interface Comparator {
  name: string;
  primary: string;
  secondary: string[];
  steps: Cmp[];
}

export const COMPARATORS: Record<string, Comparator> = {
  TRADE_ROUTE_V1: { name: "TRADE_ROUTE_V1", primary: "USABILITY", secondary: ["ALL_MARKETS_VERIFIED", "ROUTE_LIQUIDITY_DESC", "HOPS_ASC", "COMBINED_FEE_ASC", "CARD_ID"], steps: [byUsability, routeVerified, liquidityDesc, hopsAsc, feeAsc, byId] },
  TRADE_QUOTE_V1: { name: "TRADE_QUOTE_V1", primary: "USABILITY", secondary: ["EXPECTED_OUTPUT_DESC", "PRICE_IMPACT_ASC", "QUOTE_BLOCK_DESC", "CARD_ID"], steps: [byUsability, outputDesc, impactAsc, quoteFresher, byId] },
  LEND_V1: { name: "LEND_V1", primary: "USABILITY", secondary: ["SUPPLY_APY_DESC", "AVAILABLE_LIQUIDITY_DESC", "TVL_DESC", "CARD_ID"], steps: [byUsability, rateDesc("SUPPLY_APY"), liquidityDesc, tvlDesc, byId] },
  VAULT_V1: { name: "VAULT_V1", primary: "USABILITY", secondary: ["NET_APY_DESC", "TVL_DESC", "CARD_ID"], steps: [byUsability, rateDesc("NET_APY"), tvlDesc, byId] },
  FIXED_YIELD_V1: { name: "FIXED_YIELD_V1", primary: "USABILITY", secondary: ["MATURITY_KNOWN", "IMPLIED_APY_DESC (same unit only)", "LIQUIDITY_DESC", "MATURITY_ASC", "CARD_ID"], steps: [byUsability, maturityKnown, rateDesc("IMPLIED_APY"), liquidityDesc, maturityAsc, byId] },
  // YT: never ordered by the speculative YIELD_EXPOSURE_APY.
  YIELD_V1: { name: "YIELD_V1", primary: "USABILITY", secondary: ["LIQUIDITY_DESC", "MATURITY_ASC", "CARD_ID"], steps: [byUsability, liquidityDesc, maturityAsc, byId] },
  LP_V1: { name: "LP_V1", primary: "USABILITY", secondary: ["NET_APY_DESC (same unit only)", "LIQUIDITY_DESC", "CARD_ID"], steps: [byUsability, rateDesc("NET_APY"), liquidityDesc, byId] },
  // Different borrow assets are different intents: grouped by borrow asset first.
  COLLATERAL_V1: { name: "COLLATERAL_V1", primary: "USABILITY", secondary: ["BORROW_ASSET_GROUP", "BORROW_APY_ASC", "BORROWABLE_LIQUIDITY_DESC", "LLTV_DESC", "CARD_ID"], steps: [byUsability, counterSymbol, rateAsc("BORROW_APY"), liquidityDesc, lltvDesc, byId] },
};

export function comparatorFor(sub: ProductSubcategory, quoted: boolean): Comparator {
  switch (sub) {
    case "TRADE":
      return quoted ? COMPARATORS.TRADE_QUOTE_V1! : COMPARATORS.TRADE_ROUTE_V1!;
    case "LEND":
      return COMPARATORS.LEND_V1!;
    case "VAULT":
      return COMPARATORS.VAULT_V1!;
    case "FIXED_YIELD":
      return COMPARATORS.FIXED_YIELD_V1!;
    case "YIELD":
      return COMPARATORS.YIELD_V1!;
    case "LP":
      return COMPARATORS.LP_V1!;
    case "COLLATERAL":
      return COMPARATORS.COLLATERAL_V1!;
  }
}

export class IncompatibleRankingError extends Error {
  override readonly name = "IncompatibleRankingError";
}

/**
 * Orders cards of ONE subcategory. Throws if cards from different subcategories are mixed, or if
 * quoted trade cards do not share input asset, output asset and input amount.
 */
export function rankCards(cards: readonly ProductCard[], sub: ProductSubcategory, context: Record<string, string> = {}): ProductCard[] {
  if (cards.some((c) => c.subcategory !== sub)) throw new IncompatibleRankingError(`cannot rank ${[...new Set(cards.map((c) => c.subcategory))].join(" vs ")} together`);
  const quoted = sub === "TRADE" && cards.some((c) => c.trade?.quote);
  if (quoted) {
    const q0 = cards.find((c) => c.trade?.quote)!.trade!.quote!;
    for (const c of cards) {
      const q = c.trade?.quote;
      if (!q) continue;
      if (q.input.asset.key !== q0.input.asset.key || q.expectedOutput.asset.key !== q0.expectedOutput.asset.key || q.input.raw !== q0.input.raw) {
        throw new IncompatibleRankingError("quoted routes are comparable only for the same input asset, output asset and input amount");
      }
    }
  }
  const cmp = comparatorFor(sub, quoted);
  const sorted = [...cards].sort((a, b) => {
    for (const s of cmp.steps) {
      const r = s(a, b);
      if (r !== 0) return r;
    }
    return 0;
  });
  return sorted.map((c, i): ProductCard => ({ ...c, ranking: { comparator: cmp.name, primary: cmp.primary, secondary: cmp.secondary, position: i + 1, ...(Object.keys(context).length ? { context } : {}) } satisfies RankingFactors }));
}
