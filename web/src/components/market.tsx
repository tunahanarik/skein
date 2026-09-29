/**
 * Building blocks of the "market" design: intent cards, opportunity rows, the inline asset
 * picker, the ticker strip, the wallet summary and the quick swap / bridge panel.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type AggregatorRow, type AssetListItem, type Card, type Intelligence, type Portfolio } from "../api";
import { amount, pct, pctE18, usd } from "../format";
import { useI18n } from "../i18n";
import { INTENT_CAT, intentsOf, type Intent, type IntentKey } from "../intents";
import { linkProps, navigate } from "../router";
import { actionLabel, contextLine } from "../text";
import { BridgeForm } from "../pages/Bridge";
import { useWallet } from "../wallet";
import { useLive } from "../live";
import { Avatar, UsabilityBadge, useAssetList } from "./common";
import { canSwap, SwapBody } from "./SwapDialog";
import { Badge, Icon, type IconName } from "./icons";
import { AggregatorSwap } from "./AggregatorSwap";
import { parseUnits } from "viem";

/** Icon and pastel family per intent. */
export const INTENT_LOOK: Record<IntentKey, { icon: IconName; tone: "earn" | "fixed" | "borrow" | "lp" | "trade" }> = {
  EARN: { icon: "earn", tone: "earn" },
  FIXED: { icon: "lock", tone: "fixed" },
  BORROW: { icon: "bank", tone: "borrow" },
  LIQUIDITY: { icon: "drop", tone: "lp" },
  TRADE: { icon: "swap", tone: "trade" },
};

/* ---------------- intent cards ---------------- */

export function intentValue(t: ReturnType<typeof useI18n>["t"], i: Intent, agg?: AggregatorRow | null): { v: string; foot: string } {
  const who = i.protocols.slice(0, 2).join(", ");
  const aggOk = agg && (agg.cls === "GOOD" || agg.cls === "OK");
  if (i.key === "TRADE" && !i.count && aggOk) return { v: t("intent.aggV"), foot: t("intent.foot.agg", { s: agg!.toolName ?? "LI.FI" }) };
  if (i.key === "TRADE") return { v: String(i.count), foot: i.count ? (aggOk ? t("intent.foot.assetsAgg") : t("intent.foot.assets")) : t("intent.foot.none") };
  if (!i.usable.length) return { v: "—", foot: t("intent.foot.none") };
  if (i.key === "BORROW") return { v: i.best !== null ? pct(i.best, 0) : String(i.count), foot: `${t("intent.foot.ltv")} · ${who}` };
  return { v: i.best !== null ? pct(i.best, 1) : String(i.count), foot: i.count > 1 ? t("intent.foot.options", { n: i.count, p: who }) : who };
}

/** Five intent cards. With `selected`, they act as a filter (aria-pressed); otherwise as links. */
export function IntentCards({ v, selected, onSelect, hrefFor, agg }: { v: Intelligence; selected?: IntentKey | null; onSelect?: (k: IntentKey | null) => void; hrefFor?: (k: IntentKey) => string; agg?: AggregatorRow | null }) {
  const { t } = useI18n();
  const intents = intentsOf(v);
  return (
    <div className="intents" role="group" aria-label={t("asset.canDo")}>
      {intents.map((i) => {
        const { v: val, foot } = intentValue(t, i, agg);
        const aggOk = !!agg && (agg.cls === "GOOD" || agg.cls === "OK");
        const off = i.key === "TRADE" ? i.count === 0 && !aggOk : i.usable.length === 0;
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

/* ---------------- opportunity rows ---------------- */


/** "Protocol · context", without repeating the protocol when the context already starts with it. */
function subline(protocol: string, ctx: string): string {
  if (!ctx) return protocol;
  return ctx.toLowerCase().startsWith(protocol.toLowerCase()) ? ctx : `${protocol} · ${ctx}`;
}

export function OpportunityRows({ rows, assetRef }: { rows: { intent: IntentKey; card: Card }[]; assetRef: string }) {
  const { t } = useI18n();
  if (!rows.length) return <div className="panel empty small">{t("home.noOpps")}</div>;
  return (
    <div className="opps">
      {rows.map(({ intent, card }) => {
        const val = intent === "BORROW" ? (card.lltv ? pctE18(card.lltv, 0) : "—") : card.headline ? pctE18(card.headline.value, 1) : "—";
        const unit = intent === "BORROW" ? t("intent.unit.ltv") : card.headline?.basis === "FIXED" || intent === "FIXED" ? t("intent.unit.fixed") : t("intent.unit.apy");
        return (
          <a key={card.cardId} className="opp" {...linkProps(`/asset/${encodeURIComponent(assetRef)}?i=${intent}`)}>
            <Badge icon={INTENT_LOOK[intent].icon} tone={INTENT_LOOK[intent].tone} size={38} />
            <span className="main">
              <span className="l">{actionLabel(t, card)}</span>
              <span className="c">{subline(card.protocol.name, contextLine(t, card))}</span>
            </span>
            <UsabilityBadge status={card.usability.status} />
            <span className="val num">
              {val}
              <small>{unit}</small>
            </span>
            <span className="go" aria-hidden="true">
              <Icon name="chevron" size={18} />
            </span>
          </a>
        );
      })}
    </div>
  );
}

/* ---------------- inline asset picker ---------------- */

/** A big inline button showing the asset; opens a searchable list. */
export function AssetPicker({ value, onChange, label, only }: { value: AssetListItem | null; onChange: (a: AssetListItem) => void; label: string; only?: string[] | null }) {
  const { t } = useI18n();
  const list = useAssetList();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const l = only ? (list ?? []).filter((a) => only.includes(a.symbol)) : (list ?? []);
    // Every asset (no cap): core assets first, then stock tokens A–Z.
    const rank = (a: AssetListItem) => (a.type === "STOCK_TOKEN" ? 1 : 0);
    return (s ? l.filter((a) => a.symbol.toLowerCase().includes(s) || a.name.toLowerCase().includes(s) || a.address.toLowerCase() === s) : l)
      .slice()
      .sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
  }, [list, q, only]);
  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-l`} aria-label={`${label}: ${value?.symbol ?? ""}`} onClick={() => setOpen(!open)}>
        <Avatar symbol={value?.symbol ?? "?"} address={value?.address ?? null} />
        <span>{value?.symbol ?? "…"}</span>
        <span className="chev" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="picker-pop panel" id={`${id}-l`}>
          <input className="input" autoFocus placeholder={t("search.placeholder")} aria-label={t("search.label")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
          <div className="faint small" style={{ padding: "6px 4px 0" }}>
            {t("picker.count", { n: shown.length })}
          </div>
          <div role="listbox" className="picker-list">
            {shown.map((a) => (
              <button
                key={a.key}
                role="option"
                aria-selected={a.key === value?.key}
                className="picker-opt"
                onClick={() => {
                  onChange(a);
                  setOpen(false);
                  setQ("");
                }}
              >
                <Avatar symbol={a.symbol} address={a.address} />
                <span className="s">{a.symbol}</span>
                <span className="n">{a.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- markets data (shared) ---------------- */

let marketsCache: { at: number; p: Promise<Map<string, number | null>> } | null = null;
/** Today's change (vs the previous close) of an asset, from /api/markets (cached for a minute). */
export function useTodayChange(key: string | null): number | null {
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    if (!marketsCache || Date.now() - marketsCache.at > 60_000) {
      marketsCache = { at: Date.now(), p: api.markets().then((m) => new Map((Array.isArray(m?.rows) ? m.rows : []).map((r) => [r.key, r.changePct])), () => new Map()) };
    }
    marketsCache.p.then((m) => live && setV(m.get(key) ?? null));
    return () => {
      live = false;
    };
  }, [key]);
  return v;
}

/* ---------------- ticker strip ---------------- */

const TICKER = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "SPY", "WETH"];
type Tick = { symbol: string; ref: string; usd: number | null; change: number | null };
let tickCache: { at: number; ticks: Tick[] } | null = null;

export function Ticker() {
  useI18n(); // re-render on language change (number format follows the locale)
  const list = useAssetList();
  const [ticks, setTicks] = useState<Tick[] | null>(tickCache?.ticks ?? null);
  const keys = useMemo(() => (list ? TICKER.map((s) => list.find((a) => a.symbol === s)).filter((a): a is AssetListItem => !!a).map((a) => a.key) : []), [list]);
  const live = useLive({ prices: keys });
  useEffect(() => {
    if (!list || (tickCache && Date.now() - tickCache.at < 120_000)) return;
    let live = true;
    // One request: price (Chainlink) and today's change vs the previous close, same as the Markets page.
    api.markets().then((m) => {
      const rows = Array.isArray(m?.rows) ? m.rows : [];
      const r: Tick[] = TICKER.map((sym) => rows.find((x) => x.symbol === sym))
        .filter((x): x is NonNullable<typeof x> => !!x)
        .map((x) => ({ symbol: x.symbol === "WETH" ? "ETH" : x.symbol, ref: x.symbol, usd: x.usd, change: x.changePct }));
      tickCache = { at: Date.now(), ticks: r };
      if (live) setTicks(r);
    }, () => undefined);
    return () => {
      live = false;
    };
  }, [list]);
  if (!ticks) return <div className="ticker" aria-hidden="true" />;
  return (
    <div className="ticker" aria-label="Prices">
      <div className="shell">
        {ticks
          .filter((x) => x.usd !== null)
          .map((x) => {
            const k = list?.find((a) => a.symbol === x.ref)?.key;
            const lp = k ? live.prices.get(k) : undefined;
            const mv = k ? live.moves.get(k) : undefined;
            const flash = mv && Date.now() - mv.at < 1500 ? (mv.dir > 0 ? " up" : " down") : "";
            return (
            <a key={x.symbol} {...linkProps(`/asset/${x.ref}`)}>
              <span className="s">{x.symbol}</span> <span className={`num${flash}`}>{usd(lp ? lp.usd : String(x.usd))}</span>{" "}
              {x.change !== null && <span className={`num ${x.change > 0 ? "up" : x.change < 0 ? "down" : ""}`}>{`${x.change > 0 ? "+" : ""}${pct(x.change, 2)}`}</span>}
            </a>
            );
          })}
      </div>
    </div>
  );
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
          <div className="big num">{usd(String(total))}</div>
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

/* ---------------- quick panel (swap / bridge) ---------------- */

type Tab = "swap" | "bridge";
const QuickCtx = createContext<{ open: (tab: Tab, from?: string) => void } | null>(null);
export const useQuick = () => {
  const v = useContext(QuickCtx);
  if (!v) throw new Error("QuickProvider missing");
  return v;
};

export function QuickProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ tab: Tab; from?: string } | null>(null);
  const open = useCallback((tab: Tab, from?: string) => setState({ tab, ...(from ? { from } : {}) }), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <QuickCtx.Provider value={value}>
      {children}
      {state && <QuickPanel tab={state.tab} from={state.from} onTab={(tab) => setState({ ...state, tab })} onClose={() => setState(null)} />}
    </QuickCtx.Provider>
  );
}

function QuickPanel({ tab, from, onTab, onClose }: { tab: Tab; from?: string; onTab: (t: Tab) => void; onClose: () => void }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={t(`quick.${tab}`)} tabIndex={-1} ref={ref}>
        <div className="drawer-head">
          <div className="seg-tabs" role="tablist">
            {(["swap", "bridge"] as const).map((x) => (
              <button key={x} role="tab" aria-selected={tab === x} className={tab === x ? "on" : undefined} onClick={() => onTab(x)}>
                {t(`quick.${x}`)}
              </button>
            ))}
          </div>
          <button className="btn small ghost" onClick={onClose} aria-label={t("modal.close")}>
            ✕
          </button>
        </div>
        <div className="drawer-body">{tab === "swap" ? <QuickSwap from={from} /> : <BridgeForm />}</div>
      </div>
    </div>
  );
}

function QuickSwap({ from }: { from?: string }) {
  const { t } = useI18n();
  const list = useAssetList();
  const [fromA, setFromA] = useState<AssetListItem | null>(null);
  const [to, setTo] = useState("");
  const [amt, setAmt] = useState("1");
  const [targets, setTargets] = useState<string[] | null>(null);
  const [state, setState] = useState<{ loading: boolean; card: Card | null; none: boolean; err: string | null }>({ loading: false, card: null, none: false, err: null });

  useEffect(() => {
    if (!list || fromA) return;
    setFromA(list.find((a) => a.symbol === (from ?? "NVDA")) ?? list.find((a) => a.address.toLowerCase() === from?.toLowerCase()) ?? list[0] ?? null);
  }, [list, from, fromA]);
  useEffect(() => {
    if (!fromA) return;
    const ac = new AbortController();
    setTargets(null);
    setState({ loading: false, card: null, none: false, err: null });
    api.asset(fromA.address, {}, ac.signal).then(
      (v) => {
        // Uniswap v3 targets, plus USDG and WETH, which the aggregator (LI.FI) can route for any token.
        const syms = [...new Set([...v.tradeTargets.map((x) => x.symbol), "USDG", "WETH"])].filter((x) => x !== fromA.symbol);
        const order = ["USDG", "WETH"];
        syms.sort((a, b) => (order.includes(a) ? order.indexOf(a) : 9) - (order.includes(b) ? order.indexOf(b) : 9) || a.localeCompare(b));
        setTargets(syms);
        setTo((cur) => (syms.includes(cur) ? cur : (syms[0] ?? "")));
      },
      () => setTargets([]),
    );
    return () => ac.abort();
  }, [fromA]);

  const valid = /^\d+(\.\d+)?$/.test(amt) && Number(amt) > 0;
  const toA = list?.find((a) => a.symbol === to) ?? null;
  const aggAmount = (() => {
    if (!fromA || !valid) return null;
    try {
      return parseUnits(amt, fromA.decimals);
    } catch {
      return null;
    }
  })();
  async function quote() {
    if (!fromA || !to || !valid) return;
    setState({ loading: true, card: null, none: false, err: null });
    try {
      const v = await api.asset(fromA.address, { to, amount: amt });
      const cards = v.categories.find((c) => c.category === "TRADE")?.subcategories.flatMap((s) => s.cards) ?? [];
      const card = cards.find(canSwap) ?? null;
      setState({ loading: false, card, none: !card, err: null });
    } catch {
      // Not a Uniswap v3 target (e.g. USDG added for the aggregator): use the aggregator.
      setState({ loading: false, card: null, none: true, err: null });
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="qs-box">
        <div className="muted small">{t("quick.pay")}</div>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input className="qs-amt num" inputMode="decimal" aria-label={t("bridge.amount")} value={amt} onChange={(e) => (setAmt(e.target.value.replace(",", ".").replace(/[^0-9.]/g, "")), setState((s) => ({ ...s, card: null, none: false })))} />
          <AssetPicker label={t("quick.pay")} value={fromA} onChange={(a) => setFromA(a)} />
        </div>
      </div>
      <div className="qs-box">
        <div className="muted small">{t("quick.get")}</div>
        <div className="row" style={{ flexWrap: "nowrap", justifyContent: "space-between" }}>
          <span className={`qs-amt num${state.card ? "" : " ph"}`}>{state.card?.trade?.quote ? amount(state.card.trade.quote.expectedOutput.display, 6) : state.loading || !targets ? "…" : "0"}</span>
          <AssetPicker label={t("quote.into")} only={targets} value={list?.find((a) => a.symbol === to) ?? null} onChange={(a) => (setTo(a.symbol), setState((s) => ({ ...s, card: null, none: false })))} />
        </div>
        {targets && !targets.length && <div className="muted small">{t("quote.noTargets")}</div>}
      </div>
      {!state.card && (
        <button className="btn primary big" disabled={!valid || !to || state.loading} onClick={() => void quote()}>
          {state.loading ? t("quote.quoting") : t("quick.getQuote")}
        </button>
      )}
      {state.none && fromA && toA && aggAmount !== null && (
        <>
          <div className="muted small">{t("agg.fallback")}</div>
          <AggregatorSwap key={`${fromA.key}-${toA.key}-${amt}`} from={{ ...fromA, address: fromA.address as `0x${string}` }} to={{ ...toA, address: toA.address as `0x${string}` }} amountRaw={aggAmount} />
        </>
      )}
      {state.err && <div className="notice bad small">{state.err}</div>}
      {state.card && <SwapBody key={state.card.cardId} card={state.card} />}
      {!state.card && <div className="faint small qs-note">{t("quick.note")}</div>}
    </div>
  );
}

export { INTENT_CAT };
