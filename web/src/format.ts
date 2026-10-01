/** Display formatting only. Server values are exact decimal strings; rounding happens here, for humans. */

let locale = "en-US";
/** Set by the i18n provider; number and date formatting follow the chosen language. */
export function setLocale(l: string): void {
  locale = l;
}

export function usd(v: string | null | undefined, opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined) return "·";
  const n = Number(v);
  if (!Number.isFinite(n)) return "·";
  if (opts.compact && Math.abs(n) >= 10_000) return "$" + new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const digits = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 4;
  return "$" + n.toLocaleString(locale, { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
}

export function amount(v: string | null | undefined, max = 6): string {
  if (v === null || v === undefined) return "·";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString(locale, { maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? Math.max(max, 4) : max });
}

/** Fixed number of decimals in the app's locale (e.g. prices ≥ 1 with two decimals). */
export function fixed(n: number, digits: number): string {
  return n.toLocaleString(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** 1e18-scaled fraction string → percent. */
export function pctE18(v: string | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "·";
  return pct(Number(v) / 1e16, digits);
}

/** `n` is in percent units (7.28 → "7.28%"); placement and spacing follow the locale. */
export function pct(n: number, digits = 2, minDigits = digits): string {
  // A real minus sign, never a hyphen (house style: no dashes anywhere in the UI).
  const s = new Intl.NumberFormat(locale, { style: "percent", minimumFractionDigits: minDigits, maximumFractionDigits: digits }).format(n / 100).replace(/-/g, "−");
  // A value that rounds to zero carries no sign ("0.00%", never "−0.00%").
  return /[1-9١-٩१-९]/.test(s) ? s : s.replace("−", "");
}

/** Server-formatted percent ("7.28%") → localized. */
export function pctText(display: string): string {
  const m = /^(-?[\d.]+)%$/.exec(display.trim());
  if (!m) return display;
  const digits = (m[1]!.split(".")[1] ?? "").length;
  return pct(Number(m[1]), digits);
}

/** Age parts; the caller renders them with the translated unit. */
export function agoParts(iso: string | null | undefined, nowMs = Date.now()): { unit: "s" | "m" | "h" | "d"; n: number } | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 90) return { unit: "s", n: s };
  if (s < 5400) return { unit: "m", n: Math.round(s / 60) };
  if (s < 172800) return { unit: "h", n: Math.round(s / 3600) };
  return { unit: "d", n: Math.round(s / 86400) };
}

/** Official Robinhood Chain explorer (src/config/chains.ts, from the chain docs). Addresses only. */
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export function explorerAddress(a: string): string | null {
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? `${EXPLORER}/address/${a}` : null;
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return "·";
  return new Date(iso).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Machine ids shown to people ("uniswap-v4", "beefy-api", "official_api") as words: "Uniswap v4", "Beefy API", "official API". */
export function prettyId(s: string): string {
  return s.replace(/\b[a-z0-9]+(?:[-_][a-z0-9]+)+\b/gi, (id) =>
    id
      .split(/[-_]/)
      .map((w, i) => (/^(api|tvl|lp|amm|clm)$/i.test(w) ? w.toUpperCase() : /^v\d+$/i.test(w) ? w.toLowerCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase()))
      .join(" "),
  );
}

/** ISO dates inside server text ("matures 2026-10-15", "at or after 2027-03-25T00:00:00Z") in the reader's format. */
export function humanDates(s: string): string {
  return s.replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?/g, (iso) => date(iso));
}

export function feePpm(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined) return "·";
  return pct(ppm / 10_000, 3, 0);
}
