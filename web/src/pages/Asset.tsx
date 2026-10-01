import { useEffect, useMemo, useState } from "react";
import { api, ApiFailure, type Card, type Intelligence, type Sub } from "../api";
import { CardView } from "../components/CardView";
import { OpportunityTable } from "../components/OpportunityTable";
import { RouteTable } from "../components/RouteTable";
import { Avatar, ErrorBox, ExplorerLink, LoadingCards, Notice, Skeleton, useAssetList, useAsync } from "../components/common";
import { amount, pct, prettyId, usd } from "../format";
import { useI18n } from "../i18n";
import { AlertForm } from "../components/AlertForm";
import { PriceChart } from "../components/PriceChart";
import { linkProps } from "../router";
import { useWatchlist } from "../watchlist";
import { ago, code } from "../text";
import { IntentCards, useQuick, usePortfolio } from "../components/market";
import { INTENT_CAT, INTENTS, type IntentKey } from "../intents";
import { useWallet } from "../wallet";
import { LivePairs } from "../components/LivePairs";
import { useTodayChange } from "../components/market";
import { AggregatorPanel, useAggregator } from "../components/AggregatorSwap";
import { useLive } from "../live";

type Cat = "TRADE" | "EARN" | "BORROW" | "LIQUIDITY";
const CATS: Cat[] = ["TRADE", "EARN", "BORROW", "LIQUIDITY"];

export function AssetPage({ assetRef }: { assetRef: string }) {
  const { t } = useI18n();
  const [showHidden, setShowHidden] = useState(false);
  // ?i=EARN|FIXED|BORROW|LIQUIDITY|TRADE preselects an intent (links from the home page).
  const [intent, setIntent] = useState<IntentKey | null>(() => {
    const i = new URLSearchParams(location.search).get("i");
    return (INTENTS as string[]).includes(i ?? "") ? (i as IntentKey) : null;
  });
  const focus: Cat | null = intent ? INTENT_CAT[intent] : null;
  const agg = useAggregator();
  useEffect(() => {
    if (!intent) return;
    const tm = setTimeout(() => document.getElementById("opps")?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 250);
    return () => clearTimeout(tm);
  }, [intent]);
  const res = useAsync((s) => api.asset(assetRef, showHidden ? { mode: "debug" } : {}, s), [assetRef, showHidden]);
  const list = useAssetList();
  const v = res.data;
  const meta = list?.find((a) => v?.asset && a.key === v.asset.key);

  if (res.error) {
    return (
      <div style={{ maxWidth: 640 }}>
        <h1 className="keep-case" style={{ marginBottom: 14 }}>{assetRef}</h1>
        <ErrorBox error={res.error} onRetry={res.reload} />
        <p className="muted">
          <a {...linkProps("/")}>{t("err.searchOther")}</a>
        </p>
      </div>
    );
  }

  const n = v?.summary.counts;
  return (
    <>
      <AssetHeader v={v} name={meta?.name ?? null} assetRef={assetRef} />
      {v?.asset && <LivePairs assetKey={v.asset.key} symbol={v.asset.symbol} />}
      {v ? (
        <IntentCards v={v} selected={intent} onSelect={setIntent} agg={v.asset ? (agg?.get(v.asset.key) ?? null) : null} />
      ) : (
        <div className="intents">
          {INTENTS.map((c) => (
            <div key={c} className="intent off">
              <Skeleton h={14} w="50%" />
              <Skeleton h={26} w="40%" />
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ margin: "14px 0 0" }}>
        {v && <QualityNote v={v} />}
        <span className="spacer" />
        <label className="toggle">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          {t("asset.showHidden")}
        </label>
      </div>

      {v?.emptyStates
        .filter((e) => e !== "NO_BALANCE")
        .map((e) => (
          <div key={e} style={{ marginTop: 12 }}>
            <Notice kind={e === "NO_USABLE_OPPORTUNITIES" || e === "NO_OPPORTUNITIES" ? "info" : "warn"}>
              <span>{code(t, "empty", e)}</span>
            </Notice>
          </div>
        ))}

      {!v && (
        <div className="section">
          <LoadingCards />
        </div>
      )}
      <div id="opps" />
      {v &&
        CATS.filter((c) => !focus || focus === c).map((c) => {
          const cv = v.categories.find((x) => x.category === c);
          const subs = (cv?.subcategories ?? []).filter((x) => (intent === "FIXED" ? x.subcategory === "FIXED_YIELD" : intent === "EARN" ? x.subcategory !== "FIXED_YIELD" : true));
          return <CategorySection key={c} cat={c} subs={subs} v={v} assetRef={assetRef} focused={focus === c} />;
        })}

      {v?.excluded && v.excluded.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{t("asset.hiddenTitle", { n: v.excluded.length })}</h2>
            <span className="muted">{t("asset.hiddenHint")}</span>
          </div>
          <div className="grid two">
            {v.excluded.map((c) => (
              <CardView key={c.cardId} card={c} showRank={false} />
            ))}
          </div>
        </section>
      )}

      {v && n && (
        <p className="faint small" style={{ marginTop: 30 }}>
          {t("asset.footer", {
            b: v.blockNumber,
            from: v.freshness.oldestCriticalDataAt ? ago(t, v.freshness.oldestCriticalDataAt) : "·",
            to: v.freshness.newestDataAt ? ago(t, v.freshness.newestDataAt) : "·",
            d: n.discovered,
            v: n.verified,
            a: n.actionable,
            l: n.limited,
            h: n.hidden + n.unavailable,
          })}
        </p>
      )}
    </>
  );
}

function AssetHeader({ v, name, assetRef }: { v: Intelligence | null; name: string | null; assetRef: string }) {
  const { t } = useI18n();
  const watch = useWatchlist();
  const a = v?.asset;
  const live = useLive({ prices: a ? [a.key] : [] });
  const lp = a ? live.prices.get(a.key) : undefined;
  const mv = a ? live.moves.get(a.key) : undefined;
  const flash = mv && Date.now() - mv.at < 1500 ? (mv.dir > 0 ? " up" : " down") : "";
  const today = useTodayChange(a?.key ?? null);
  return (
    <div className="asset-hero">
      <div className="main">
        <div className="ident">
          <Avatar symbol={a?.symbol ?? assetRef} address={a?.address ?? null} size="lg" />
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <h1 className="keep-case">{a?.symbol ?? assetRef}</h1>
              {a?.registryType && <span className="tag">{code(t, "type", a.registryType)}</span>}
            </div>
            <div className="muted small" style={{ overflowWrap: "anywhere" }}>
              {name ?? ""}
              {a && (
                <>
                  {name ? " · " : ""}
                  <ExplorerLink address={a.address} />
                </>
              )}
            </div>
          </div>
        </div>
        {v ? (
          <>
            <div className="price-row">
              <span className={`price num${flash}`}>{lp ? usd(lp.usd) : v.price?.usd ? usd(v.price.usd) : t("asset.unpriced")}</span>
              {lp && <span className="live-dot on" title={t("live.price")} aria-label={t("live.price")} />}
              {today !== null && (
                <span className={`num ${today >= 0 ? "up" : "down"}`} style={{ fontSize: 15 }}>
                  {today >= 0 ? "+" : ""}
                  {pct(today, 2)} {t("asset.today")}
                </span>
              )}
              <span className="small muted">
                {v.price?.usd
                  ? `${v.price.method === "ROBINHOOD_QUOTE_MID" ? t("asset.rhQuote") : t("asset.chainlink")} · ${ago(t, v.price.observedAt)} · ${code(t, "fresh", v.price.freshness)}`
                  : v.price?.unpricedReason}
              </span>
            </div>
            {v.asset && <PriceChart assetRef={v.asset.address} />}
          </>
        ) : (
          <Skeleton h={34} w={160} />
        )}
        {a && (
          <div className="row small" style={{ gap: 8, marginTop: 8 }}>
            <button className="pill" aria-pressed={watch.has(a.key)} onClick={() => watch.toggle(a.key)} title={watch.has(a.key) ? t("watch.remove") : t("watch.add")} aria-label={watch.has(a.key) ? t("watch.remove") : t("watch.add")}>
              {watch.has(a.key) ? "★" : "☆"}
            </button>
            <a className="pill" {...linkProps(`/compare?a=${encodeURIComponent(a.symbol)}&b=${a.symbol === "TSLA" ? "NVDA" : "TSLA"}`)}>
              {t("watch.compare")}
            </a>
            {v?.price?.usd && (
              <details className="more">
                <summary>{t("alert.set")}</summary>
                <div className="body">
                  <AlertForm kind="PRICE" assetRef={a.address} symbol={a.symbol} label={t("alert.price")} current={Number(v.price.usd)} />
                </div>
              </details>
            )}
          </div>
        )}
      </div>
      <HoldBox v={v} />
    </div>
  );
}

/** Your balance of this asset (connected wallet), with the quick actions. */
function HoldBox({ v }: { v: Intelligence | null }) {
  const { t } = useI18n();
  const w = useWallet();
  const quick = useQuick();
  const p = usePortfolio(w.address);
  const a = v?.asset;
  const mine = a ? p?.assets.find((x) => x.asset?.key === a.key) : undefined;
  const bal = mine?.balance;
  const toOpps = () => document.getElementById("opps")?.scrollIntoView?.({ behavior: "smooth" });
  return (
    <aside className="panel pad hold-box">
      {w.address ? (
        <>
          <div className="muted small">{t("hold.you")}</div>
          <div className="big num">{bal ? `${amount(bal.displayBalance, 4)} ${a?.symbol ?? ""}` : p ? `0 ${a?.symbol ?? ""}` : "…"}</div>
          <div className="muted small">{bal?.valueUsd ? usd(bal.valueUsd.display) : ""}</div>
          {bal && Number(bal.displayBalance) > 0 && (
            <button className="btn primary round" onClick={toOpps}>
              {t("hold.put")}
            </button>
          )}
        </>
      ) : (
        <>
          <div className="muted small">{t("hold.connectHint")}</div>
          <button className="btn primary round" onClick={w.openPicker}>
            {t("shell.connect")}
          </button>
        </>
      )}
      <div className="row small hold-links">
        <button className="linkish" onClick={() => quick.open("swap", a?.symbol)}>
          {t("quick.swap")}
        </button>
        <button className="linkish" onClick={() => quick.open("bridge")}>
          {t("quick.bridge")}
        </button>
      </div>
    </aside>
  );
}

function QualityNote({ v }: { v: Intelligence }) {
  const { t } = useI18n();
  const q = v.dataQuality;
  if (q.status === "COMPLETE") return <span className="small" style={{ color: "var(--ok)" }}>● {t("quality.COMPLETE")}</span>;
  return (
    <Notice kind={q.status === "UNKNOWN" ? "bad" : "warn"}>
      <span>
        <strong>{t(`quality.${q.status}`)}.</strong> {[...new Set(q.reasons.map((r) => (r.protocol ? r.protocol[0]!.toUpperCase() + r.protocol.slice(1) : prettyId(r.code.toLowerCase()))))].join(", ")}
      </span>
    </Notice>
  );
}

function CategorySection({ cat, subs, v, assetRef, focused }: { cat: Cat; subs: Sub[]; v: Intelligence; assetRef: string; focused: boolean }) {
  const { t } = useI18n();
  const empty = subs.length === 0;
  if (empty && !focused && cat !== "TRADE") return null;
  return (
    <section className="section" aria-labelledby={`h-${cat}`}>
      <div className="section-head">
        <h2 id={`h-${cat}`}>{t(`cat.${cat}`)}</h2>
        <span className="muted">{t(`catBlurb.${cat}`)}</span>
      </div>
      {cat === "TRADE" && v.asset && <QuotePanel v={v} assetRef={assetRef} />}
      {cat === "TRADE" && v.asset && v.asset.registryType === "STOCK_TOKEN" && <AggregatorPanel asset={{ key: v.asset.key, address: v.asset.address, symbol: v.asset.symbol, decimals: v.asset.decimals }} />}
      {empty && <div className="panel empty small">{t("asset.nothingInCat", { s: v.asset?.symbol ?? "" })}</div>}
      {subs.map((s) => (s.subcategory === "TRADE" ? <TradeRoutes key="trade" sub={s} v={v} /> : <SubSection key={s.subcategory} sub={s} />))}
    </section>
  );
}

function SubSection({ sub }: { sub: Sub }) {
  const { t } = useI18n();
  return (
    <div style={{ marginTop: 14 }}>
      <div className="section-head" style={{ marginBottom: 8 }}>
        <h3>{code(t, "sub", sub.subcategory)}</h3>
        <span className="faint small">{code(t, "cmp", sub.comparator)}</span>
      </div>
      {sub.cards.length > 6 ? (
        <OpportunityTable cards={sub.cards} />
      ) : (
        <div className="grid two">
          {sub.cards.map((c) => (
            <CardView key={c.cardId} card={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function groupByTarget(cards: Card[]) {
  const groups: { target: string; symbol: string; cards: Card[] }[] = [];
  for (const c of cards) {
    const target = c.ranking?.context?.target ?? "-";
    let g = groups.find((x) => x.target === target);
    if (!g) groups.push((g = { target, symbol: c.trade?.route.path.at(-1)?.symbol ?? "?", cards: [] }));
    g.cards.push(c);
  }
  return groups;
}

function TradeRoutes({ sub, v }: { sub: Sub; v: Intelligence }) {
  const { t } = useI18n();
  const groups = groupByTarget(sub.cards);
  const other = v.otherTradeDestinations;
  return (
    <>
      {groups.map((g) => {
        const more = sub.moreRoutes?.find((m) => m.target === g.target);
        return (
          <div key={g.target} style={{ marginTop: 14 }}>
            <div className="section-head" style={{ marginBottom: 8 }}>
              <h3>
                {v.asset?.symbol} → {g.symbol}
              </h3>
              <span className="faint small">{code(t, "cmp", sub.comparator)}</span>
            </div>
            <RouteTable cards={g.cards} />
            {more && (
              <p className="small muted" style={{ margin: "8px 0 0" }}>
                {t("asset.moreRoutes", { n: more.total - more.shown, s: g.symbol })}
              </p>
            )}
          </div>
        );
      })}
      {other.direct + other.oneHop > 0 && (
        <p className="small muted" style={{ marginTop: 10 }}>
          {t("asset.otherDest", { n: other.direct + other.oneHop, d: other.direct })}
        </p>
      )}
    </>
  );
}

function QuotePanel({ v, assetRef }: { v: Intelligence; assetRef: string }) {
  const { t } = useI18n();
  const sym = v.asset!.symbol;
  // Only assets actually reachable through verified routes; hubs first, then alphabetical.
  const targets = useMemo(() => {
    const hubs = ["USDG", "WETH"];
    const rank = (s: string) => (hubs.includes(s) ? hubs.indexOf(s) : hubs.length);
    const seen = new Set<string>();
    const dup = new Set(v.tradeTargets.map((x) => x.symbol).filter((s, i, a) => a.indexOf(s) !== i));
    return v.tradeTargets
      .filter((x) => !dup.has(x.symbol) && !seen.has(x.symbol) && seen.add(x.symbol))
      .sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol))
      .map((x) => x.symbol);
  }, [v.tradeTargets]);
  const [to, setTo] = useState(targets.includes("USDG") ? "USDG" : (targets[0] ?? ""));
  const [amt, setAmt] = useState("1");
  const [state, setState] = useState<{ loading: boolean; error: ApiFailure | null; data: Intelligence | null; asked: string | null }>({ loading: false, error: null, data: null, asked: null });
  const validAmt = /^\d+(\.\d+)?$/.test(amt) && Number(amt) > 0 && amt.length <= 40;

  const run = async () => {
    if (!validAmt) return;
    const asked = `${amount(amt)} ${sym} → ${to}`;
    setState({ loading: true, error: null, data: null, asked });
    try {
      const data = await api.asset(assetRef, { to, amount: amt });
      setState({ loading: false, error: null, data, asked });
    } catch (e) {
      setState({ loading: false, error: e instanceof ApiFailure ? e : new ApiFailure(0, "ERROR", String(e)), data: null, asked: null });
    }
  };

  const tradeSub = state.data?.categories.find((c) => c.category === "TRADE")?.subcategories[0];
  const top = tradeSub?.cards[0]?.trade?.quote;
  if (targets.length === 0) return <div className="panel pad muted small" style={{ marginBottom: 6 }}>{t("quote.noTargets")}</div>;
  return (
    <div className="panel pad" style={{ marginBottom: 6 }}>
      <form
        className="quote-form"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label>
          {t("quote.amountOf", { s: sym })}
          <input className="input num" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} aria-invalid={!validAmt} />
        </label>
        <label>
          {t("quote.into")}
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            {targets.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={!validAmt || state.loading}>
          {state.loading ? t("quote.quoting") : t("quote.compare")}
        </button>
        <span className="faint small" style={{ maxWidth: 360 }}>
          {t("quote.hint")}
        </span>
      </form>
      {state.error && (
        <div style={{ marginTop: 12 }}>
          <ErrorBox error={state.error} />
        </div>
      )}
      {state.loading && (
        <div style={{ marginTop: 14, display: "grid", gap: 8 }} aria-busy="true">
          <Skeleton h={14} w="40%" />
          <Skeleton h={36} />
          <Skeleton h={36} />
          <Skeleton h={36} />
        </div>
      )}
      {state.data && (
        <div style={{ marginTop: 14 }}>
          <div className="section-head" style={{ marginBottom: 8 }}>
            <h3>{t("quote.for", { x: state.asked ?? "" })}</h3>
            <span className="faint small">{t("cmp.TRADE_QUOTE_V1")}</span>
          </div>
          {!tradeSub || tradeSub.cards.length === 0 ? <div className="muted small">{t("quote.none")}</div> : <RouteTable cards={tradeSub.cards} />}
          {tradeSub?.moreRoutes?.map((m) => (
            <p key={m.target} className="small muted" style={{ margin: "8px 0 0" }}>
              {t("quote.more", { n: m.total - m.shown })}
            </p>
          ))}
          {top && (
            <p className="faint small" style={{ marginBottom: 0 }}>
              {t("quote.top", { x: `${amount(top.expectedOutput.display)} ${top.expectedOutput.asset.symbol}` })}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
