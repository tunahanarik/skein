/** Display formatting only. Server values are exact decimal strings; rounding happens here, for humans. */

export function usd(v: string | null | undefined, opts: { compact?: boolean } = {}): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (opts.compact && Math.abs(n) >= 10_000) return "$" + new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  const digits = Math.abs(n) >= 1000 ? 0 : Math.abs(n) >= 1 ? 2 : 4;
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: Math.min(2, digits), maximumFractionDigits: digits });
}

export function amount(v: string | null | undefined, max = 6): string {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString("en-US", { maximumFractionDigits: n !== 0 && Math.abs(n) < 1 ? Math.max(max, 4) : max });
}

/** 1e18-scaled fraction string → percent. */
export function pctE18(v: string | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "—";
  return (Number(v) / 1e16).toFixed(digits) + "%";
}

export function ago(iso: string | null | undefined, nowMs = Date.now()): string {
  if (!iso) return "unknown age";
  const s = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
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
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function feePpm(ppm: number | null | undefined): string {
  if (ppm === null || ppm === undefined) return "—";
  return (ppm / 10_000).toFixed(ppm % 100 === 0 ? 2 : 3).replace(/0+$/, "").replace(/\.$/, "") + "%";
}
