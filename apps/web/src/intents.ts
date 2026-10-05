/**
 * "What can this asset do?" — the product's five intents, derived from an AssetIntelligence
 * response. Pure functions; the UI (IntentCards, opportunity lists) renders the result.
 *
 *   EARN       supply, vaults, savings and other variable yield   (headline: highest APY)
 *   FIXED      fixed yield to a maturity (Pendle PT)               (highest implied APY)
 *   BORROW     use the asset as collateral                          (highest LLTV, lowest APY)
 *   LIQUIDITY  provide liquidity / earn trading fees                (highest APR)
 *   TRADE      swap into another asset                               (number of destinations)
 *
 * Only usable cards (ACTIONABLE or LIMITED) count toward a headline; the rest stay listed on the
 * asset page with their reasons.
 */
import type { Card, Intelligence } from "./api";

export type IntentKey = "EARN" | "FIXED" | "BORROW" | "LIQUIDITY" | "TRADE";
export const INTENTS: IntentKey[] = ["EARN", "FIXED", "BORROW", "LIQUIDITY", "TRADE"];
/** Product category each intent lives in (asset page sections are per category). */
export const INTENT_CAT: Record<IntentKey, "EARN" | "BORROW" | "LIQUIDITY" | "TRADE"> = { EARN: "EARN", FIXED: "EARN", BORROW: "BORROW", LIQUIDITY: "LIQUIDITY", TRADE: "TRADE" };
const SUBS: Record<IntentKey, string[]> = { EARN: ["LEND", "VAULT", "YIELD"], FIXED: ["FIXED_YIELD"], BORROW: ["COLLATERAL"], LIQUIDITY: ["LP"], TRADE: ["TRADE"] };

export interface Intent {
  key: IntentKey;
  cards: Card[];
  /** Usable cards (ACTIONABLE or LIMITED). */
  usable: Card[];
  /** Headline in percent units (7.2 = 7.2%), or null. BORROW: highest LLTV. TRADE: null. */
  best: number | null;
  /** BORROW only: lowest borrow APY among usable cards, percent units. */
  cost: number | null;
  /** TRADE: number of reachable assets. Others: number of usable cards. */
  count: number;
  protocols: string[];
}

const usable = (c: Card) => c.usability.status === "ACTIONABLE" || c.usability.status === "LIMITED";
const pct18 = (v: string | bigint | null | undefined) => (v === null || v === undefined ? null : Number(v) / 1e16);

export function intentsOf(v: Intelligence): Intent[] {
  const all = v.categories.flatMap((c) => c.subcategories);
  return INTENTS.map((key) => {
    const cards = all.filter((s) => SUBS[key].includes(s.subcategory)).flatMap((s) => s.cards);
    const u = cards.filter(usable);
    // Outlier rates (above 100 %, unverified) never become an intent's best or cost.
    const heads = u.filter((c) => !c.headline?.outlier).map((c) => pct18(c.headline?.value)).filter((x): x is number => x !== null && Number.isFinite(x));
    const best =
      key === "TRADE"
        ? null
        : key === "BORROW"
          ? Math.max(...u.map((c) => pct18(c.lltv) ?? -1), -1)
          : heads.length
            ? Math.max(...heads)
            : null;
    return {
      key,
      cards,
      usable: u,
      best: best !== null && best >= 0 ? best : null,
      cost: key === "BORROW" && heads.length ? Math.min(...heads) : null,
      count: key === "TRADE" ? new Set(v.tradeTargets.map((x) => x.key)).size : u.length,
      protocols: [...new Set(u.map((c) => c.protocol.name.split(" + ")).flat())],
    };
  });
}

/**
 * Non-trade opportunities for the "where it can go" list: usable first, then by headline
 * (earn side high first; borrow cards by LLTV). One list across intents.
 */
export function topOpportunities(v: Intelligence, limit = 6): { intent: IntentKey; card: Card }[] {
  const rows = intentsOf(v)
    .filter((i) => i.key !== "TRADE")
    .flatMap((i) => i.cards.map((card) => ({ intent: i.key, card })));
  const score = (r: { intent: IntentKey; card: Card }) => (r.intent === "BORROW" ? (pct18(r.card.lltv) ?? 0) / 10 : r.card.headline?.outlier ? 0 : (pct18(r.card.headline?.value) ?? 0));
  const rank = (c: Card) => (c.usability.status === "ACTIONABLE" ? 0 : c.usability.status === "LIMITED" ? 1 : 2);
  return rows.sort((a, b) => rank(a.card) - rank(b.card) || score(b) - score(a)).slice(0, limit);
}
