import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Market } from "../api";
import { Avatar, Skeleton, useAsync } from "../components/common";
import { Icon } from "../components/icons";
import { pct, usd } from "../format";
import { useI18n } from "../i18n";
import { linkProps, navigate } from "../router";
import { useWatchlist } from "../watchlist";

type Filter = "all" | "stocks" | "etfs" | "saved";
/** Funds among the Stock Tokens, by their registry name. */
const FUND = /\b(ETF|Trust|Fund|iShares|SPDR|Vanguard|Invesco|Schwab|VanEck|Select Sector)\b/i;
const shortName = (n: string) => n.replace(/\s*•\s*Robinhood Token$/i, "").replace(/\s+(Inc\.?|Corp\.?|Corporation|Common Stock|Class [A-Z].*)$/i, "");

/** Tiny 1-day line, loaded only when the row scrolls into view (one cached request per asset). */
function Spark({ address, up }: { address: string; up: boolean | null }) {
  const ref = useRef<SVGSVGElement>(null);
  const [pts, setPts] = useState<number[] | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let live = true;
    const load = () =>
      api.chart(address, "1D").then(
        (c) => live && setPts((c.points ?? []).map((p) => Number(p.usd)).filter((v) => v > 0)),
        () => live && setPts([]),
      );
    if (typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((e) => {
      if (e.some((x) => x.isIntersecting)) {
        io.disconnect();
        void load();
      }
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
    const hi = Math.max(...s) || 1;
    d = s.map((v, i) => `${i ? "L" : "M"}${((i / (s.length - 1)) * 76).toFixed(1)},${(22 - ((v - lo) / (hi - lo || 1)) * 18).toFixed(1)}`).join("");
  }
  return (
    <svg ref={ref} className="spark" width="76" height="26" viewBox="0 0 76 26" aria-hidden="true">
      {d && <path d={d} fill="none" stroke={up === false ? "var(--bad)" : "var(--ok)"} strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

export function MarketsPage() {
  const { t } = useI18n();
  const res = useAsync((s) => api.markets(s), []);
  const watch = useWatchlist();
  const [q, setQ] = useState("");
  const [f, setF] = useState<Filter>("all");
  const rows = useMemo(() => {
    const all = res.data?.rows ?? [];
    const s = q.trim().toLowerCase();
    return all
      .filter((r) => (f === "all" ? true : f === "saved" ? watch.has(r.key) : f === "etfs" ? r.type === "STOCK_TOKEN" && FUND.test(r.name) : r.type === "STOCK_TOKEN" && !FUND.test(r.name)))
      .filter((r) => !s || r.symbol.toLowerCase().includes(s) || r.name.toLowerCase().includes(s) || r.address.toLowerCase() === s)
      .sort((a, b) => (a.type === "STOCK_TOKEN" ? 1 : 0) - (b.type === "STOCK_TOKEN" ? 1 : 0) || a.symbol.localeCompare(b.symbol));
  }, [res.data, q, f, watch]);

  return (
    <div className="markets">
      <div className="mk-head">
        <h1>{t("markets.title")}</h1>
        <label className="mk-search">
          <Icon name="search" size={18} />
          <span className="sr-only">{t("search.label")}</span>
          <input placeholder={t("markets.search", { n: res.data?.rows.length ?? 197 })} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <div className="chips" role="radiogroup" aria-label={t("markets.title")}>
        {(["all", "stocks", "etfs", "saved"] as const).map((x) => (
          <button key={x} role="radio" aria-checked={f === x} className={`chip${f === x ? " on" : ""}`} onClick={() => setF(x)}>
            {x === "saved" && <Icon name="star" size={14} />} {t(`markets.${x}`)}
          </button>
        ))}
      </div>

      <div className="panel mk-list">
        {!res.data && !res.error && (
          <div style={{ padding: 16, display: "grid", gap: 14 }}>
            <Skeleton h={36} />
            <Skeleton h={36} />
            <Skeleton h={36} />
          </div>
        )}
        {res.data && !rows.length && <div className="empty small">{t("markets.empty")}</div>}
        {rows.map((r: Market) => (
          <a key={r.key} className="mk-row" {...linkProps(`/asset/${encodeURIComponent(r.symbol)}`)} onClick={(e) => (e.preventDefault(), navigate(`/asset/${encodeURIComponent(r.symbol)}`))}>
            <Avatar symbol={r.symbol} address={r.address} />
            <span className="nm">
              <span className="n">{shortName(r.name)}</span>
              <span className="s">{r.symbol}</span>
            </span>
            <Spark address={r.address} up={r.changePct === null ? null : r.changePct >= 0} />
            <span className="px">
              <span className="num">{r.usd !== null ? usd(String(r.usd)) : "—"}</span>
              <span className={`num ch ${r.changePct === null ? "" : r.changePct >= 0 ? "up" : "down"}`}>{r.changePct === null ? "—" : `${r.changePct >= 0 ? "+" : ""}${pct(r.changePct, 2)}`}</span>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
