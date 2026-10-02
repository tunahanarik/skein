/**
 * Building blocks of the "market" design: intent cards, opportunity values, the inline asset
 * picker, market and portfolio hooks and the wallet summary.
 */
import { Fragment, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api, type AssetListItem, type Card, type Intelligence, type Portfolio } from "../api";
import { amount, pct, pctE18, usd } from "../format";
import { useI18n } from "../i18n";
import { INTENT_CAT, intentsOf, type Intent, type IntentKey } from "../intents";
import { linkProps } from "../router";
import { Avatar, useAssetList } from "./common";
import { Badge, type IconName } from "./icons";
import { CountUp } from "./motion";

/** Icon and pastel family per intent. */
export const INTENT_LOOK: Record<IntentKey, { icon: IconName; tone: "earn" | "fixed" | "borrow" | "lp" | "trade" }> = {
  EARN: { icon: "earn", tone: "earn" },
  FIXED: { icon: "lock", tone: "fixed" },
  BORROW: { icon: "bank", tone: "borrow" },
  LIQUIDITY: { icon: "drop", tone: "lp" },
  TRADE: { icon: "swap", tone: "trade" },
};

/* ---------------- intent cards ---------------- */

export function intentValue(t: ReturnType<typeof useI18n>["t"], i: Intent): { v: string; foot: string } {
  const who = i.protocols.slice(0, 2).join(", ");
  if (i.key === "TRADE") return { v: String(i.count), foot: i.count ? t("intent.foot.assets") : t("intent.foot.none") };
  if (!i.usable.length) return { v: "·", foot: t("intent.foot.none") };
  if (i.key === "BORROW") return { v: i.best !== null ? pct(i.best, 0) : String(i.count), foot: `${t("intent.foot.ltv")} · ${who}` };
  return { v: i.best !== null ? pct(i.best, 1) : String(i.count), foot: i.count > 1 ? t("intent.foot.options", { n: i.count, p: who }) : who };
}

/** Five intent cards. With `selected`, they act as a filter (aria-pressed); otherwise as links. */
export function IntentCards({ v, selected, onSelect, hrefFor }: { v: Intelligence; selected?: IntentKey | null; onSelect?: (k: IntentKey | null) => void; hrefFor?: (k: IntentKey) => string }) {
  const { t } = useI18n();
  const intents = intentsOf(v);
  return (
    <div className="intents" role="group" aria-label={t("asset.canDo")}>
      {intents.map((i) => {
        const { v: val, foot } = intentValue(t, i);
        const off = i.key === "TRADE" ? i.count === 0 : i.usable.length === 0;
        const body = (
          <>
            <Badge icon={INTENT_LOOK[i.key].icon} tone={INTENT_LOOK[i.key].tone} />
            <span className="k">{t(`intent.${i.key}`)}</span>
            <span className="v num">{val}</span>
            <span className="f">{foot}</span>
          </>
        );
        const cls = `intent i-${i.key.toLowerCase()}${off ? " off" : ""}${selected === i.key ? " sel" : ""}`;
        return onSelect ? (
          <button key={i.key} className={cls} aria-pressed={selected === i.key} onClick={() => onSelect(selected === i.key ? null : i.key)}>
            {body}
          </button>
        ) : (
          <a key={i.key} className={cls} {...linkProps(hrefFor ? hrefFor(i.key) : "#")}>
            {body}
          </a>
        );
      })}
    </div>
  );
}

/* ---------------- opportunity values ---------------- */

/** The headline number of an opportunity and its unit (APY, fixed APY or max LTV). */
export function oppValue(t: ReturnType<typeof useI18n>["t"], intent: IntentKey, card: Card): { val: string; unit: string } {
  const val = intent === "BORROW" ? (card.lltv ? pctE18(card.lltv, 0) : "·") : card.headline ? pctE18(card.headline.value, 1) : "·";
  const unit = intent === "BORROW" ? t("intent.unit.ltv") : card.headline?.basis === "FIXED" || intent === "FIXED" ? t("intent.unit.fixed") : t("intent.unit.apy");
  return { val, unit };
}

/* ---------------- inline asset picker ---------------- */

/** Funds among the Stock Tokens, by their registry name. */
const FUND = /\b(ETF|Trust|Fund|iShares|SPDR|Vanguard|Invesco|Schwab|VanEck|Select Sector)\b/i;
type PickKind = "all" | "crypto" | "stocks" | "etfs";
const kindOf = (a: AssetListItem): Exclude<PickKind, "all"> => (a.type !== "STOCK_TOKEN" ? "crypto" : FUND.test(a.name) ? "etfs" : "stocks");
const shortName = (n: string) => n.replace(/\s*•\s*Robinhood Token$/i, "");

/**
 * Asset chooser: a search line, asset-class tabs, grouped rows with price and today's change, and
 * full keyboard use (↑ ↓ to move, Enter to choose, Esc to close). Opens on the page's top layer.
 */
export function AssetPicker({ value, onChange, label, only, placeholder }: { value: AssetListItem | null; onChange: (a: AssetListItem) => void; label: string; only?: string[] | null; placeholder?: string }) {
  const { t } = useI18n();
  const list = useAssetList();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<PickKind>("all");
  const [hi, setHi] = useState(0);
  const quotes = useMarketQuotes(open);
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  // Focus the search once the portal has been placed (autoFocus loses to the button's own click focus).
  useEffect(() => {
    if (!open) return;
    const r = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(r);
  }, [open, pos]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !popRef.current?.contains(e.target as Node) && setOpen(false);
    // The list opens on the page's top layer (a portal), so no panel can clip or restyle it:
    // placed under the button, or above it when there is more room there.
    const place = () => {
      const r = ref.current?.getBoundingClientRect();
      if (!r) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(420, vw - 16);
      const left = Math.min(Math.max(8, r.right - w), vw - w - 8);
      const below = vh - r.bottom - 16;
      const above = r.top - 16;
      const x = { left, right: "auto", width: w };
      setPos(below >= 320 || below >= above ? { ...x, top: r.bottom + 8, bottom: "auto", maxHeight: Math.min(520, Math.max(240, below)) } : { ...x, top: "auto", bottom: vh - r.top + 8, maxHeight: Math.min(520, above) });
    };
    place();
    document.addEventListener("mousedown", close);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  const pool = useMemo(() => (only ? (list ?? []).filter((a) => only.includes(a.symbol)) : (list ?? [])), [list, only]);
  const counts = useMemo(() => {
    const c = { all: pool.length, crypto: 0, stocks: 0, etfs: 0 };
    for (const a of pool) c[kindOf(a)]++;
    return c;
  }, [pool]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const l = pool.filter((a) => kind === "all" || kindOf(a) === kind);
    if (s) {
      // Exact symbol, symbol prefix, name prefix, then anywhere in the name; address exact.
      const rank = (a: AssetListItem) => {
        const sym = a.symbol.toLowerCase();
        const name = shortName(a.name).toLowerCase();
        return sym === s || a.address.toLowerCase() === s ? 0 : sym.startsWith(s) ? 1 : name.startsWith(s) ? 2 : sym.includes(s) || name.includes(s) ? 3 : 9;
      };
      return l.filter((a) => rank(a) < 9).sort((a, b) => rank(a) - rank(b) || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol));
    }
    // No query: crypto first, then stocks, then funds; A–Z inside each group.
    const order = { crypto: 0, stocks: 1, etfs: 2 } as const;
    return l.slice().sort((a, b) => order[kindOf(a)] - order[kindOf(b)] || a.symbol.localeCompare(b.symbol));
  }, [pool, q, kind]);
  useEffect(() => setHi(0), [q, kind]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${hi}"]`)?.scrollIntoView({ block: "nearest" });
  }, [hi]);
  const choose = (a: AssetListItem) => {
    onChange(a);
    setOpen(false);
    setQ("");
  };
  const grouped = !q.trim() && kind === "all";

  return (
    <div className="picker" ref={ref}>
      <button type="button" className="picker-btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-l`} aria-label={`${label}: ${value?.symbol ?? ""}`} onMouseEnter={() => void loadMarkets()} onFocus={() => void loadMarkets()} onClick={() => setOpen(!open)}>
        {(value || !placeholder) && <Avatar symbol={value?.symbol ?? "?"} address={value?.address ?? null} />}
        <span>{value?.symbol ?? placeholder ?? "…"}</span>
        <span className="chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open &&
        createPortal(
          <div className="picker-pop panel apick" id={`${id}-l`} ref={popRef} style={pos ?? { visibility: "hidden" }}>
            <label className="ap-search">
              <span className="ap-prompt" aria-hidden="true">
                &gt;
              </span>
              <input
                ref={searchRef}
                placeholder={t("search.placeholder")}
                aria-label={t("search.label")}
                value={q}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setOpen(false);
                  else if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, shown.length - 1)));
                  else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
                  else if (e.key === "Enter" && shown[hi]) (e.preventDefault(), choose(shown[hi]!));
                }}
              />
            </label>
            <div className="ap-tabs" role="tablist">
              {(["all", "crypto", "stocks", "etfs"] as const).map((k) =>
                counts[k] || k === "all" ? (
                  <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>
                    {t(`markets.${k}`)} <span className="c">{counts[k]}</span>
                  </button>
                ) : null,
              )}
            </div>
            <div role="listbox" className="picker-list ap-list" ref={listRef} aria-label={label}>
              {shown.map((a, i) => {
                const g = kindOf(a);
                const head = grouped && (i === 0 || kindOf(shown[i - 1]!) !== g);
                const qte = quotes?.get(a.key);
                return (
                  <Fragment key={a.key}>
                    {head && <div className="ap-group">{t(`markets.${g}`)}</div>}
                    <button
                      type="button"
                      role="option"
                      data-i={i}
                      aria-selected={a.key === value?.key}
                      className={`picker-opt ap-opt${i === hi ? " hi" : ""}${a.key === value?.key ? " cur" : ""}`}
                      onMouseEnter={() => setHi(i)}
                      onClick={() => choose(a)}
                    >
                      <Avatar symbol={a.symbol} address={a.address} />
                      <span className="nm">
                        <span className="s">{a.symbol}</span>
                        <span className="n">{shortName(a.name)}</span>
                      </span>
                      <span className="px">
                        <span className="num">{qte?.usd != null ? usd(String(qte.usd)) : ""}</span>
                        {qte?.changePct != null && <span className={`num ch ${qte.changePct >= 0 ? "up" : "down"}`}>{`${qte.changePct >= 0 ? "+" : ""}${pct(qte.changePct, 2)}`}</span>}
                      </span>
                    </button>
                  </Fragment>
                );
              })}
              {!shown.length && <div className="ap-empty">{t("markets.empty")}</div>}
            </div>
            <div className="ap-foot">
              <span>{t("picker.count", { n: shown.length })}</span>
              <span className="spacer" />
              <span className="keys">
                <kbd>↑</kbd>
                <kbd>↓</kbd> {t("picker.move")} <kbd>↵</kbd> {t("picker.choose")} <kbd>esc</kbd> {t("picker.close")}
              </span>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ---------------- markets data (shared) ---------------- */

type MarketQuote = { usd: number | null; changePct: number | null };
let marketsCache: { at: number; p: Promise<Map<string, MarketQuote>> } | null = null;
/** Price and today's change of every asset, from /api/markets (one request, cached for a minute). */
function loadMarkets(): Promise<Map<string, MarketQuote>> {
  if (!marketsCache || Date.now() - marketsCache.at > 60_000) {
    marketsCache = { at: Date.now(), p: api.markets().then((m) => new Map((Array.isArray(m?.rows) ? m.rows : []).map((r) => [r.key, { usd: r.usd, changePct: r.changePct }])), () => new Map()) };
  }
  return marketsCache.p;
}
export function useMarketQuotes(enabled = true): Map<string, MarketQuote> | null {
  const [m, setM] = useState<Map<string, MarketQuote> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void loadMarkets().then((x) => live && setM(x));
    return () => {
      live = false;
    };
  }, [enabled]);
  return m;
}
/** Today's change (vs the previous close) of an asset. */
export function useTodayChange(key: string | null): number | null {
  const m = useMarketQuotes(!!key);
  return key ? (m?.get(key)?.changePct ?? null) : null;
}

/* ---------------- wallet ---------------- */

const portfolioCache = new Map<string, { at: number; p: Promise<Portfolio> }>();
/** Portfolio for the connected / pasted address (cached for a minute, memory only). */
export function usePortfolio(address: string | null): Portfolio | null {
  const [p, setP] = useState<Portfolio | null>(null);
  useEffect(() => {
    setP(null);
    if (!address) return;
    let live = true;
    const k = address.toLowerCase();
    let hit = portfolioCache.get(k);
    if (!hit || Date.now() - hit.at > 60_000) {
      hit = { at: Date.now(), p: api.portfolio(address) };
      portfolioCache.set(k, hit);
      hit.p.catch(() => portfolioCache.delete(k));
    }
    hit.p.then((r) => live && setP(r), () => undefined);
    return () => {
      live = false;
    };
  }, [address]);
  return p;
}

/** Idle holdings with the best usable earn option for each, largest first. */
export function idleSuggestions(p: Portfolio): { asset: Intelligence; valueUsd: number; best: Intent | null }[] {
  return p.assets
    .map((a) => {
      const valueUsd = Number(a.balance?.valueUsd?.display ?? 0) || 0;
      const earn = intentsOf(a).filter((i) => i.key !== "TRADE" && i.key !== "BORROW" && i.best !== null);
      const best = earn.sort((x, y) => (y.best ?? 0) - (x.best ?? 0))[0] ?? null;
      return { asset: a, valueUsd, best };
    })
    .filter((x) => x.asset.asset && x.valueUsd > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd);
}

export function WalletSummary({ p }: { p: Portfolio }) {
  const { t } = useI18n();
  const s = idleSuggestions(p);
  const total = Number(p.portfolioValueUsd ?? p.pricedValueUsd) || 0;
  const withEarn = s.filter((x) => x.best);
  const colors = ["var(--accent)", "var(--i-fixed-fg)", "var(--i-borrow-fg)", "var(--i-lp-fg)", "var(--text-3)"];
  return (
    <div className="panel pad wallet-sum">
      <div className="row">
        <div>
          <div className="muted small">{t("wsum.total")}</div>
          <div className="big num">
            <CountUp value={total} format={(n) => usd(String(n))} final={usd(String(total))} />
          </div>
        </div>
        <span className="spacer" />
        <div style={{ textAlign: "end" }}>
          <div className="muted small">{t("wsum.positions", { n: p.positions.length })}</div>
          <a className="small" {...linkProps("/wallet")}>
            {t("wsum.open")}
          </a>
        </div>
      </div>
      {total > 0 && (
        <div className="alloc" aria-hidden="true">
          {s.slice(0, 5).map((x, i) => (
            <span key={x.asset.asset!.key} style={{ width: `${(x.valueUsd / total) * 100}%`, background: colors[i] }} />
          ))}
        </div>
      )}
      <div className="alloc-legend small muted">
        {s.slice(0, 5).map((x) => (
          <span key={x.asset.asset!.key}>
            {x.asset.asset!.symbol} {pct((x.valueUsd / (total || 1)) * 100, 0)}
          </span>
        ))}
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {withEarn.slice(0, 3).map((x) => (
          <div key={x.asset.asset!.key} className="idle">
            <Avatar symbol={x.asset.asset!.symbol} address={x.asset.asset!.address} />
            <span className="main">
              <span>{t("wsum.idle", { x: `${amount(x.asset.balance?.displayBalance ?? "0", 4)} ${x.asset.asset!.symbol}` })}</span>
              <span className="muted small">{t("wsum.could", { r: pct(x.best!.best!, 1), p: x.best!.protocols[0] ?? "" })}</span>
            </span>
            <a className="btn small primary" {...linkProps(`/asset/${encodeURIComponent(x.asset.asset!.symbol)}?i=${x.best!.key}`)}>
              {t("wsum.put")}
            </a>
          </div>
        ))}
        {!withEarn.length && <div className="muted small">{t("wsum.none")}</div>}
      </div>
    </div>
  );
}

export { INTENT_CAT };
