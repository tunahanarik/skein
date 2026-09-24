/**
 * Helpers that turn machine codes and structured card data into translated text.
 * All wording lives in i18n/strings.ts.
 */
import type { Card } from "./api";
import { agoParts, date } from "./format";
import type { StringKey } from "./i18n";

type T = (key: StringKey, vars?: Record<string, string | number>) => string;

/** Translate a code under a prefix, falling back to the raw code for unknown values. */
export function code(t: T, prefix: string, c: string | null | undefined): string {
  if (!c) return "";
  const k = `${prefix}.${c}` as StringKey;
  const s = t(k);
  return s === k ? c : s;
}

export function ago(t: T, iso: string | null | undefined): string {
  const p = agoParts(iso);
  return p ? t(`misc.ago.${p.unit}` as StringKey, { n: p.n }) : t("misc.unknownAge");
}

/** Action label from structured data (the server's English label is the fallback). */
export function actionLabel(t: T, c: Card): string {
  const a = c.asset.symbol;
  if (c.trade) return t("action.TRADE", { a: c.trade.route.path[0]?.symbol ?? a, b: c.trade.route.path.at(-1)?.symbol ?? "?" });
  switch (c.subcategory) {
    case "LEND":
      return t("action.LEND", { a });
    case "VAULT":
      return t("action.VAULT", { a });
    case "FIXED_YIELD":
    case "YIELD":
      return t(`action.${c.subcategory}`, { a, out: c.counterAsset?.symbol ?? (c.subcategory === "FIXED_YIELD" ? "PT" : "YT") });
    case "COLLATERAL":
      return t("action.COLLATERAL", { a, b: c.counterAsset?.symbol ?? "?" });
    case "LP":
      return t("action.LP", { a });
    default:
      return c.actionLabel;
  }
}

/** Short, language-neutral context line: protocol and, for maturity products, the maturity date. */
export function contextLine(t: T, c: Card): string {
  const parts = [c.protocol.name];
  // Language-neutral venue identity taken from the adapter's title: market pair + LLTV, or vault name.
  const market = /market (\S+\/\S+) \(LLTV ([\d.]+)%\)/.exec(c.context ?? "");
  if (market) parts.push(`${market[1]} · LLTV ${market[2]}%`);
  const vault = /vault "(.+)"/.exec(c.context ?? "");
  if (vault) parts.push(vault[1]!);
  if (c.maturity && (c.subcategory === "FIXED_YIELD" || c.subcategory === "YIELD" || c.subcategory === "LP")) parts.push(t("ctx.matures", { d: date(c.maturity) }));
  return parts.join(" · ");
}
