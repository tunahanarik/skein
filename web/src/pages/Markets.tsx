import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type Market } from "../api";
import { Avatar, Skeleton, useAsync } from "../components/common";
import { Icon } from "../components/icons";
import { pct, usd } from "../format";
import { useI18n } from "../i18n";
import { linkProps, navigate } from "../router";
import { useWatchlist } from "../watchlist";

type Kind = "all" | "stocks" | "etfs" | "saved";
type Cap = "earn" | "fixed" | "borrow" | "lp";
type View = "table" | "map" | "cards";
type SortKey = "symbol" | "usd" | "changePct" | "bestApy" | "liquidityUsd";
/** Funds among the Stock Tokens, by their registry name. */
const FUND = /\b(ETF|Trust|Fund|iShares|SPDR|Vanguard|Invesco|Schwab|VanEck|Select Sector)\b/i;
const shortName = (n: string) => n.replace(/\s*•\s*Robinhood Token$/i, "").replace(/\s+(Inc\.?|Corp\.?|Corporation|Common Stock|Class [A-Z].*)$/i, "");
const CAPS: Cap[] = ["earn", "fixed", "borrow", "lp"];
const MIN_LIQ = [0, 10_000, 100_000, 1_000_000] as const;
const VIEW_KEY = "hoodmap.markets.view";
const hrefOf = (r: Market) => `/asset/${encodeURIComponent(r.symbol)}`;
const trim = (x: string) => x.replace(/\.0$/, "");
const compactUsd = (n: number) => (n >= 1e9 ? `$${trim((n / 1e9).toFixed(1))}B` : n >= 1e6 ? `$${trim((n / 1e6).toFixed(1))}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`);

/** Tiny 1-day line, loaded only when it scrolls into view (one cached request per asset). */
function Spark({ address, up }: { address: string; up: boolean | null }) {
  const ref = useRef<SVGSVGElement>(null);
  const [pts, setPts] = useState<number[] | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let live = true;
    const io = new IntersectionObserver((e) => {
      if (!e.some((x) => x.isIntersecting)) return;
      io.disconnect();
      api.chart(address, "1D").then(
        (c) => live && setPts((c.points ?? []).map((p) => Number(p.usd)).filter((v) => v > 0)),
        () => live && setPts([]),
      );
    });
    io.observe(el);
    return () => {
      live = false;
      io.disconnect();
    };
  }, [address]);
  let d = "";
  if (pts && pts.length > 1) {
    const step = Math.max(1, Math.floor(pts.length / 40));
    const s = pts.filter((_, i) => i % step === 0);
    const lo = Math.min(...s);
    const hi = Math.max(...s);
    d = s.map((v, i) => `${i ? "L" : "M"}${((i / (s.length - 1)) * 76).toFixed(1)},${(22 - ((v - lo) / (hi - lo || 1)) * 18).toFixed(1)}`).join("");
  }
  return (
    <svg ref={ref} className="spark" width="76" height="26" viewBox="0 0 76 26" aria-hidden="true">
      {d && <path d={d} fill="none" stroke={up === false ? "var(--bad)" : "var(--ok)"} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

function Change({ v }: { v: number | null }) {
  if (v === null) return <span className="num faint">—</span>;
  return <span className={`num ${v >= 0 ? "up" : "down"}`}>{`${v >= 0 ? "+" : ""}${pct(v, 2)}`}</span>;
}

function CapTags({ r }: { r: Market }) {
  const { t } = useI18n();
  return (
    <span className="cap-tags">
      {CAPS.filter((c) => r.caps?.[c]).map((c) => (
        <span key={c} className={`ctag c-${c}`}>
          {t(`markets.tag.${c}`)}
        </span>
      ))}
    </span>
  );
}

/** Four quick lists: biggest gains and losses today, highest yield, deepest pools. */
function MoverBoard({ rows }: { rows: Market[] }) {
  const { t } = useI18n();
  const stocks = rows.filter((r) => r.type === "STOCK_TOKEN");
  const withChange = stocks.filter((r) => r.changePct !== null);
  const boxes: { title: string; list: Market[]; val: (r: Market) => ReactNode }[] = [
    { title: t("markets.gainers"), list: [...withChange].sort((a, b) => b.changePct! - a.changePct!).slice(0, 4), val: (r) => <Change v={r.changePct} /> },
    { title: t("markets.losers"), list: [...withChange].sort((a, b) => a.changePct! - b.changePct!).slice(0, 4), val: (r) => <Change v={r.changePct} /> },
    { title: t("markets.topYield"), list: stocks.filter((r) => r.bestApy !== null).sort((a, b) => b.bestApy! - a.bestApy!).slice(0, 4), val: (r) => <span className="num up">{pct(r.bestApy!, 1)}</span> },
    { title: t("markets.liquid"), list: stocks.filter((r) => r.liquidityUsd !== null).sort((a, b) => b.liquidityUsd! - a.liquidityUsd!).slice(0, 4), val: (r) => <span className="num">{compactUsd(r.liquidityUsd!)}</span> },
  ];
  return (
    <div className="mk-board">
      {boxes.map((b) => (
        <div key={b.title} className="panel mk-box">
          <div className="hd">{b.title}</div>
          {b.list.map((r) => (
            <a key={r.key} className="mk-mini" {...linkProps(hrefOf(r))}>
              <Avatar symbol={r.symbol} address={r.address} />
              <span className="s">{r.symbol}</span>
              <span className="spacer" />
              {b.val(r)}
            </a>
          ))}
        </div>
      ))}
    </div>
  );
}

type FilterState = { kind: Kind; caps: Set<Cap>; dir: "all" | "up" | "down"; minLiq: number };

function Filters({ f, set, onClear }: { f: FilterState; set: (p: Partial<FilterState>) => void; onClear: () => void }) {
  const { t } = useI18n();
  // Always open on wide screens; on phones the header toggles it (CSS).
  const [open, setOpen] = useState(false);
  const active = (f.kind !== "all" ? 1 : 0) + f.caps.size + (f.dir !== "all" ? 1 : 0) + (f.minLiq ? 1 : 0);
  return (
    <aside className="panel mk-filters" aria-label={t("markets.filters")}>
      <button className="hd mk-ftoggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {t("markets.filters")}
        {active > 0 && <span className="fcount">{active}</span>}
        <Icon name="chevron" size={14} className="chev" />
      </button>
      <div className={`mk-fbody${open ? " open" : ""}`}>
      <div className="grp">
        <div className="lbl">{t("markets.type")}</div>
        <div className="chips">
          {(["all", "stocks", "etfs", "saved"] as const).map((x) => (
            <button key={x} className={`chip${f.kind === x ? " on" : ""}`} aria-pressed={f.kind === x} onClick={() => set({ kind: x })}>
              {x === "saved" && <Icon name="star" size={13} />} {t(`markets.${x}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="grp">
        <div className="lbl">{t("markets.can")}</div>
        {CAPS.map((c) => (
          <label key={c} className="chk">
            <input
              type="checkbox"
              checked={f.caps.has(c)}
              onChange={() => {
                const n = new Set(f.caps);
                if (n.has(c)) n.delete(c);
                else n.add(c);
                set({ caps: n });
              }}
            />
            <span className={`ctag c-${c}`}>{t(`markets.tag.${c}`)}</span>
          </label>
        ))}
      </div>
      <div className="grp">
        <div className="lbl">{t("markets.today")}</div>
        <div className="chips">
          {(["all", "up", "down"] as const).map((x) => (
            <button key={x} className={`chip${f.dir === x ? " on" : ""}`} aria-pressed={f.dir === x} onClick={() => set({ dir: x })}>
              {x === "all" ? t("markets.any") : t(`markets.${x}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="grp">
        <div className="lbl">{t("markets.minLiq")}</div>
        <div className="chips">
          {MIN_LIQ.map((n) => (
            <button key={n} className={`chip${f.minLiq === n ? " on" : ""}`} aria-pressed={f.minLiq === n} onClick={() => set({ minLiq: n })}>
              {n === 0 ? t("markets.any") : compactUsd(n)}
            </button>
          ))}
        </div>
      </div>
      <button className="linkish small mk-clear" onClick={onClear}>
        {t("markets.clear")}
      </button>
      </div>
    </aside>
  );
}

function Table({ rows, sort, setSort }: { rows: Market[]; sort: { k: SortKey; desc: boolean }; setSort: (s: { k: SortKey; desc: boolean }) => void }) {
  const { t } = useI18n();
  const watch = useWatchlist();
  const th = (k: SortKey, label: string, cls = "") => (
    <th className={cls} aria-sort={sort.k === k ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button className="th-sort" onClick={() => setSort({ k, desc: sort.k === k ? !sort.desc : k !== "symbol" })}>
        {label}
        {sort.k === k && <span aria-hidden="true">{sort.desc ? " ↓" : " ↑"}</span>}
      </button>
    </th>
  );
  return (
    <div className="panel mk-table-wrap">
      <table className="mk-table">
        <thead>
          <tr>
            <th className="n">#</th>
            {th("symbol", t("markets.col.asset"))}
            {th("usd", t("markets.col.price"), "r")}
            {th("changePct", t("markets.col.today"), "r")}
            <th className="hide-s">{t("markets.col.chart")}</th>
            {th("bestApy", t("markets.col.yield"), "r")}
            {th("liquidityUsd", t("markets.col.liq"), "r hide-s")}
            <th className="hide-m">{t("markets.col.can")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const saved = watch.has(r.key);
            return (
              <tr key={r.key} onClick={() => navigate(hrefOf(r))}>
                <td className="n faint">{i + 1}</td>
                <td>
                  <a className="mk-asset" {...linkProps(hrefOf(r))} onClick={(e) => (e.stopPropagation(), e.preventDefault(), navigate(hrefOf(r)))}>
                    <Avatar symbol={r.symbol} address={r.address} />
                    <span className="nm">
                      <span className="nn">{shortName(r.name)}</span>
                      <span className="s">{r.symbol}</span>
                    </span>
                  </a>
                </td>
                <td className="r num">{r.usd !== null ? usd(String(r.usd)) : "—"}</td>
                <td className="r">
                  <Change v={r.changePct} />
                </td>
                <td className="hide-s">
                  <Spark address={r.address} up={r.changePct === null ? null : r.changePct >= 0} />
                </td>
                <td className="r">
                  {r.bestApy !== null ? (
                    <span className="apy">
                      <span className="num">{pct(r.bestApy, 1)}</span>
                      <span className="faint small">{r.bestApyProtocol}</span>
                    </span>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="r num hide-s">{r.liquidityUsd !== null ? compactUsd(r.liquidityUsd) : "—"}</td>
                <td className="hide-m">
                  <CapTags r={r} />
                </td>
                <td className="r">
                  <button
                    className={`star-btn${saved ? " on" : ""}`}
                    aria-pressed={saved}
                    aria-label={`${saved ? t("watch.remove") : t("watch.add")}: ${r.symbol}`}
                    title={saved ? t("watch.remove") : t("watch.add")}
                    onClick={(e) => {
                      e.stopPropagation();
                      watch.toggle(r.key);
                    }}
                  >
                    <Icon name="star" size={16} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Heat map: tile size follows pool liquidity, colour follows today's change. */
function HeatMap({ rows }: { rows: Market[] }) {
  const { t } = useI18n();
  const list = [...rows].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, 120);
  const liqs = list.map((r) => r.liquidityUsd ?? 0);
  const at = (p: number) => liqs[Math.floor(p * (liqs.length - 1))] ?? 0;
  const [q1, q2, q3] = [at(0.04), at(0.15), at(0.4)];
  return (
    <div className="panel mk-map-wrap">
      <div className="mk-map">
        {list.map((r) => {
          const l = r.liquidityUsd ?? 0;
          const size = l > 0 && l >= q1 ? "xl" : l > 0 && l >= q2 ? "l" : l > 0 && l >= q3 ? "m" : "s";
          const c = r.changePct ?? 0;
          const a = Math.min(1, Math.abs(c) / 4);
          const bg = r.changePct === null ? "var(--surface-2)" : `color-mix(in srgb, ${c >= 0 ? "#7fae1f" : "#c2453a"} ${Math.round(18 + a * 62)}%, var(--surface))`;
          return (
            <a key={r.key} className={`tile t-${size}`} style={{ background: bg }} {...linkProps(hrefOf(r))} title={`${shortName(r.name)} · ${r.liquidityUsd !== null ? compactUsd(r.liquidityUsd) : "—"}`}>
              <span className="s">{r.symbol}</span>
              <span className="num c">{r.changePct === null ? "—" : `${c >= 0 ? "+" : ""}${pct(c, 1)}`}</span>
            </a>
          );
        })}
      </div>
      <div className="faint small" style={{ marginTop: 10 }}>
        {t("markets.mapNote")}
      </div>
    </div>
  );
}

function Cards({ rows }: { rows: Market[] }) {
  return (
    <div className="mk-cards">
      {rows.map((r) => (
        <a key={r.key} className="panel mk-card" {...linkProps(hrefOf(r))}>
          <span className="top">
            <Avatar symbol={r.symbol} address={r.address} />
            <span className="nm">
              <span className="s">{r.symbol}</span>
              <span className="nn">{shortName(r.name)}</span>
            </span>
            <span className="spacer" />
            <Change v={r.changePct} />
          </span>
          <span className="px num">{r.usd !== null ? usd(String(r.usd)) : "—"}</span>
          <span className="bot">
            <CapTags r={r} />
            {r.bestApy !== null && <span className="num up small">{pct(r.bestApy, 1)}</span>}
          </span>
        </a>
      ))}
    </div>
  );
}

const NO_FILTERS: FilterState = { kind: "all", caps: new Set(), dir: "all", minLiq: 0 };

export function MarketsPage() {
  const { t } = useI18n();
  const res = useAsync((s) => api.markets(s), []);
  const watch = useWatchlist();
  const [q, setQ] = useState("");
  const [f, setF] = useState<FilterState>(NO_FILTERS);
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: "liquidityUsd", desc: true });
  const [view, setView] = useState<View>(() => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === "map" || v === "cards" ? v : "table";
    } catch {
      return "table";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      /* per-viewer convenience only */
    }
  }, [view]);
  const all = useMemo(() => (Array.isArray(res.data?.rows) ? res.data!.rows : []), [res.data]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = all
      .filter((r) => (f.kind === "all" ? true : f.kind === "saved" ? watch.has(r.key) : f.kind === "etfs" ? r.type === "STOCK_TOKEN" && FUND.test(r.name) : r.type === "STOCK_TOKEN" && !FUND.test(r.name)))
      .filter((r) => [...f.caps].every((c) => r.caps?.[c]))
      .filter((r) => (f.dir === "all" ? true : f.dir === "up" ? (r.changePct ?? 0) > 0 : (r.changePct ?? 0) < 0))
      .filter((r) => f.minLiq === 0 || (r.liquidityUsd ?? 0) >= f.minLiq)
      .filter((r) => !s || r.symbol.toLowerCase().includes(s) || r.name.toLowerCase().includes(s) || r.address.toLowerCase() === s);
    const val = (r: Market): number | string | null => (sort.k === "symbol" ? r.symbol : r[sort.k]);
    return out.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
      return sort.desc ? -c : c;
    });
  }, [all, q, f, sort, watch]);

  return (
    <div className="markets-wide">
      <div className="mk-head">
        <h1>{t("markets.title")}</h1>
        <span className="muted">{t("markets.count", { n: all.length || 197 })}</span>
      </div>

      {res.data ? (
        <MoverBoard rows={all} />
      ) : (
        <div className="mk-board">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="panel mk-box">
              <Skeleton h={14} w="50%" />
              <Skeleton h={22} />
              <Skeleton h={22} />
            </div>
          ))}
        </div>
      )}

      <div className="mk-body">
        <Filters f={f} set={(p) => setF((cur) => ({ ...cur, ...p }))} onClear={() => (setF(NO_FILTERS), setQ(""))} />
        <div className="mk-main">
          <div className="mk-toolbar">
            <strong>{t("markets.results", { n: rows.length })}</strong>
            <label className="mk-search">
              <Icon name="search" size={16} />
              <span className="sr-only">{t("search.label")}</span>
              <input placeholder={t("search.placeholder")} value={q} onChange={(e) => setQ(e.target.value)} />
            </label>
            <span className="spacer" />
            <div className="seg" role="radiogroup" aria-label={t("markets.viewLabel")}>
              {(["table", "map", "cards"] as const).map((v) => (
                <button key={v} role="radio" aria-checked={view === v} className={view === v ? "on" : undefined} onClick={() => setView(v)}>
                  {t(`markets.view.${v}`)}
                </button>
              ))}
            </div>
          </div>
          {!res.data && !res.error && (
            <div className="panel pad" style={{ display: "grid", gap: 14 }}>
              <Skeleton h={36} />
              <Skeleton h={36} />
              <Skeleton h={36} />
            </div>
          )}
          {res.data && !rows.length && <div className="panel empty small">{t("markets.empty")}</div>}
          {rows.length > 0 && view === "table" && <Table rows={rows} sort={sort} setSort={setSort} />}
          {rows.length > 0 && view === "map" && <HeatMap rows={rows} />}
          {rows.length > 0 && view === "cards" && <Cards rows={rows} />}
        </div>
      </div>
    </div>
  );
}
