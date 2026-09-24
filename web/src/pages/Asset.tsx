import { useMemo, useState } from "react";
import { api, ApiFailure, type Card, type Intelligence, type Sub } from "../api";
import { CardView } from "../components/CardView";
import { RouteTable } from "../components/RouteTable";
import { Avatar, ErrorBox, LoadingCards, Notice, Skeleton, useAssetList, useAsync } from "../components/common";
import { ago, amount, usd } from "../format";
import { linkProps } from "../router";
import { CATEGORY_TEXT, COMPARATOR_TEXT, EMPTY_TEXT, QUALITY_TEXT, SUB_TEXT, TYPE_TEXT } from "../text";

type Cat = "TRADE" | "EARN" | "BORROW" | "LIQUIDITY";
const CATS: Cat[] = ["TRADE", "EARN", "BORROW", "LIQUIDITY"];
const CAP_TEXT: Record<string, string> = { ACTIONABLE: "Available", LIMITED_ONLY: "Limited only", INFORMATIONAL_ONLY: "Info only", NONE: "Nothing yet" };

export function AssetPage({ assetRef }: { assetRef: string }) {
  const [showHidden, setShowHidden] = useState(false);
  const [focus, setFocus] = useState<Cat | null>(null);
  const res = useAsync((s) => api.asset(assetRef, showHidden ? { mode: "debug" } : {}, s), [assetRef, showHidden]);
  const list = useAssetList();
  const v = res.data;
  const meta = list?.find((a) => v?.asset && a.key === v.asset.key);

  if (res.error) {
    return (
      <div style={{ maxWidth: 640 }}>
        <h1 style={{ marginBottom: 14 }}>{assetRef}</h1>
        <ErrorBox error={res.error} onRetry={res.reload} />
        <p className="muted">
          <a {...linkProps("/")}>Search for another asset</a>
        </p>
      </div>
    );
  }

  return (
    <>
      <AssetHeader v={v} name={meta?.name ?? null} assetRef={assetRef} />
      {v && <Capabilities v={v} focus={focus} setFocus={setFocus} />}
      {!v && (
        <div className="caps">
          {CATS.map((c) => (
            <div key={c} className="cap">
              <Skeleton h={16} w="50%" />
              <div style={{ height: 6 }} />
              <Skeleton h={12} w="70%" />
            </div>
          ))}
        </div>
      )}

      <div className="row" style={{ margin: "14px 0 0" }}>
        {v && <QualityNote v={v} />}
        <span className="spacer" />
        <label className="toggle">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
          Show hidden items and all routes
        </label>
      </div>

      {v?.emptyStates
        .filter((e) => e !== "NO_BALANCE")
        .map((e) => (
          <div key={e} style={{ marginTop: 12 }}>
            <Notice kind={e === "NO_USABLE_OPPORTUNITIES" || e === "NO_OPPORTUNITIES" ? "info" : "warn"}>
              <span>{EMPTY_TEXT[e] ?? e}</span>
            </Notice>
          </div>
        ))}

      {!v && (
        <div className="section">
          <LoadingCards />
        </div>
      )}
      {v &&
        CATS.filter((c) => !focus || focus === c).map((c) => {
          const cv = v.categories.find((x) => x.category === c);
          return <CategorySection key={c} cat={c} subs={cv?.subcategories ?? []} v={v} assetRef={assetRef} focused={focus === c} />;
        })}

      {v?.excluded && v.excluded.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>Hidden by default ({v.excluded.length})</h2>
            <span className="muted">Shown because “Show hidden” is on. Each one lists why it is excluded.</span>
          </div>
          <div className="grid two">
            {v.excluded.map((c) => (
              <CardView key={c.cardId} card={c} showRank={false} />
            ))}
          </div>
        </section>
      )}

      {v && (
        <p className="faint small" style={{ marginTop: 30 }}>
          Block {v.blockNumber} · data from {v.freshness.oldestCriticalDataAt ? ago(v.freshness.oldestCriticalDataAt) : "—"} to{" "}
          {v.freshness.newestDataAt ? ago(v.freshness.newestDataAt) : "—"} · counted {v.summary.counts.discovered} raw opportunities ({v.summary.counts.verified} verified,{" "}
          {v.summary.counts.actionable} available, {v.summary.counts.limited} limited, {v.summary.counts.hidden + v.summary.counts.unavailable} hidden)
        </p>
      )}
    </>
  );
}

function AssetHeader({ v, name, assetRef }: { v: Intelligence | null; name: string | null; assetRef: string }) {
  const a = v?.asset;
  return (
    <div className="asset-head">
      <Avatar symbol={a?.symbol ?? assetRef} size="lg" />
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <h1>{a?.symbol ?? assetRef}</h1>
          {a?.registryType && <span className="tag">{TYPE_TEXT[a.registryType] ?? a.registryType}</span>}
        </div>
        <div className="muted small">
          {name ?? ""}
          {a && (
            <>
              {name ? " · " : ""}
              <span className="mono">{a.address}</span>
            </>
          )}
        </div>
      </div>
      <span className="spacer" />
      <div style={{ textAlign: "right" }}>
        {v ? (
          <>
            <div className="price num">{v.price?.usd ? usd(v.price.usd) : "Unpriced"}</div>
            <div className="small muted">
              {v.price?.usd ? `${v.price.method === "ROBINHOOD_QUOTE_MID" ? "Robinhood quote" : "Chainlink"} · ${ago(v.price.observedAt)} · ${v.price.freshness.toLowerCase()}` : v.price?.unpricedReason}
            </div>
          </>
        ) : (
          <Skeleton h={30} w={120} />
        )}
      </div>
    </div>
  );
}

function Capabilities({ v, focus, setFocus }: { v: Intelligence; focus: Cat | null; setFocus: (c: Cat | null) => void }) {
  const d = v.summary.capabilities.detail;
  return (
    <div className="caps" role="group" aria-label="What this asset can do">
      {CATS.map((c) => (
        <button key={c} className={`cap${focus === c ? " sel" : ""}`} aria-pressed={focus === c} onClick={() => setFocus(focus === c ? null : c)}>
          <div className="t">{CATEGORY_TEXT[c]!.title}</div>
          <div className={`s ${d[c]}`}>{CAP_TEXT[d[c]]}</div>
        </button>
      ))}
    </div>
  );
}

function QualityNote({ v }: { v: Intelligence }) {
  const q = v.dataQuality;
  if (q.status === "COMPLETE") return <span className="small" style={{ color: "var(--ok)" }}>● {QUALITY_TEXT.COMPLETE}</span>;
  return (
    <Notice kind={q.status === "UNKNOWN" ? "bad" : "warn"}>
      <span>
        <strong>{QUALITY_TEXT[q.status]}.</strong> {q.reasons.map((r) => r.code.replaceAll("_", " ").toLowerCase()).join("; ")}
      </span>
    </Notice>
  );
}

function CategorySection({ cat, subs, v, assetRef, focused }: { cat: Cat; subs: Sub[]; v: Intelligence; assetRef: string; focused: boolean }) {
  const t = CATEGORY_TEXT[cat]!;
  const empty = subs.length === 0;
  if (empty && !focused && cat !== "TRADE") return null;
  return (
    <section className="section" aria-labelledby={`h-${cat}`}>
      <div className="section-head">
        <h2 id={`h-${cat}`}>{t.title}</h2>
        <span className="muted">{t.blurb}</span>
      </div>
      {cat === "TRADE" && v.asset && <QuotePanel v={v} assetRef={assetRef} />}
      {empty && <div className="panel empty small">Nothing available for {v.asset?.symbol ?? "this asset"} in this category from the protocols we cover.</div>}
      {subs.map((s) => (s.subcategory === "TRADE" ? <TradeRoutes key="trade" sub={s} v={v} /> : <SubSection key={s.subcategory} sub={s} />))}
    </section>
  );
}

function SubSection({ sub }: { sub: Sub }) {
  return (
    <div style={{ marginTop: 14 }}>
      <div className="section-head" style={{ marginBottom: 8 }}>
        <h3>{SUB_TEXT[sub.subcategory] ?? sub.subcategory}</h3>
        <span className="faint small">{COMPARATOR_TEXT[sub.comparator] ?? sub.comparator}</span>
      </div>
      <div className="grid two">
        {sub.cards.map((c) => (
          <CardView key={c.cardId} card={c} />
        ))}
      </div>
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
  const groups = groupByTarget(sub.cards);
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
              <span className="faint small">{COMPARATOR_TEXT[sub.comparator]}</span>
            </div>
            <RouteTable cards={g.cards} />
            {more && (
              <p className="small muted" style={{ margin: "8px 0 0" }}>
                {more.total - more.shown} more route{more.total - more.shown === 1 ? "" : "s"} to {g.symbol} not shown. Turn on “Show hidden items and all routes” to list them.
              </p>
            )}
          </div>
        );
      })}
      {v.otherTradeDestinations.direct + v.otherTradeDestinations.oneHop > 0 && (
        <p className="small muted" style={{ marginTop: 10 }}>
          Routes to {v.otherTradeDestinations.direct + v.otherTradeDestinations.oneHop} other assets exist ({v.otherTradeDestinations.direct} direct). Pick one as the target above to see them.
        </p>
      )}
    </>
  );
}

function QuotePanel({ v, assetRef }: { v: Intelligence; assetRef: string }) {
  const list = useAssetList();
  const sym = v.asset!.symbol;
  const defaultTarget = sym === "USDG" ? "WETH" : "USDG";
  const [to, setTo] = useState(defaultTarget);
  const [amt, setAmt] = useState("1");
  const [state, setState] = useState<{ loading: boolean; error: ApiFailure | null; data: Intelligence | null; asked: string | null }>({ loading: false, error: null, data: null, asked: null });
  const targets = useMemo(() => {
    const base = ["USDG", "WETH"].filter((s) => s !== sym);
    const rest = (list ?? []).filter((a) => a.symbol !== sym && !base.includes(a.symbol) && list!.filter((x) => x.symbol === a.symbol).length === 1).map((a) => a.symbol);
    return [...base, ...rest];
  }, [list, sym]);
  const validAmt = /^\d+(\.\d+)?$/.test(amt) && Number(amt) > 0 && amt.length <= 40;

  const run = async () => {
    if (!validAmt) return;
    setState({ loading: true, error: null, data: null, asked: `${amt} ${sym} → ${to}` });
    try {
      const data = await api.asset(assetRef, { to, amount: amt });
      setState({ loading: false, error: null, data, asked: `${amt} ${sym} → ${to}` });
    } catch (e) {
      setState({ loading: false, error: e instanceof ApiFailure ? e : new ApiFailure(0, "ERROR", String(e)), data: null, asked: null });
    }
  };

  const tradeSub = state.data?.categories.find((c) => c.category === "TRADE")?.subcategories[0];
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
          Amount of {sym}
          <input className="input num" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} aria-invalid={!validAmt} />
        </label>
        <label>
          Into
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            {targets.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button className="btn primary" disabled={!validAmt || state.loading}>
          {state.loading ? "Quoting…" : "Compare routes"}
        </button>
        <span className="faint small" style={{ maxWidth: 360 }}>
          Indicative quotes from each pool's onchain quoter. Not a guaranteed price, no minimum output, nothing is executed.
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
            <h3>Quotes for {state.asked}</h3>
            <span className="faint small">{COMPARATOR_TEXT.TRADE_QUOTE_V1}</span>
          </div>
          {!tradeSub || tradeSub.cards.length === 0 ? (
            <div className="muted small">No verified route with enough liquidity for this amount.</div>
          ) : (
            <RouteTable cards={tradeSub.cards} />
          )}
          {tradeSub?.moreRoutes?.map((m) => (
            <p key={m.target} className="small muted" style={{ margin: "8px 0 0" }}>
              {m.total - m.shown} more quoted route(s) with lower output not shown.
            </p>
          ))}
          {tradeSub && tradeSub.cards[0]?.trade?.quote && (
            <p className="faint small" style={{ marginBottom: 0 }}>
              Top route returns about {amount(tradeSub.cards[0].trade.quote.expectedOutput.display)} {tradeSub.cards[0].trade.quote.expectedOutput.asset.symbol}. Wallets and
              aggregators may find different prices; swap fees and slippage apply.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
