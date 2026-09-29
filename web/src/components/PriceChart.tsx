import { useEffect, useMemo, useRef, useState } from "react";
import { api, type Chart } from "../api";
import { date, pct, usd } from "../format";
import { useI18n } from "../i18n";
import { ago } from "../text";

type Range = "1D" | "1W" | "1M" | "1Y";
const RANGES: Range[] = ["1D", "1W", "1M", "1Y"];
/** Refresh cadence per range (the server caches for the same order of time). */
const REFRESH_MS: Record<Range, number> = { "1D": 60_000, "1W": 5 * 60_000, "1M": 15 * 60_000, "1Y": 60 * 60_000 };
const H = 210;
const PAD = { top: 12, right: 64, bottom: 24, left: 4 };

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((e) => setW(Math.max(260, Math.floor(e[0]!.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** Price chart with day / week / month / year ranges, from real data (see src/product/charts.ts). */
export function PriceChart({ assetRef }: { assetRef: string }) {
  const { t, lang } = useI18n();
  const [range, setRange] = useState<Range>("1D");
  const [data, setData] = useState<Chart | null>(null);
  const [err, setErr] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const [box, width] = useWidth<HTMLDivElement>();

  useEffect(() => {
    let live = true;
    const ac = new AbortController();
    const load = () =>
      api.chart(assetRef, range, ac.signal).then(
        // Anything that is not a chart (e.g. an error body) counts as "no data".
        (d) => live && (d?.source && Array.isArray(d.points) ? (setData(d), setErr(false)) : setErr(true)),
        (e) => live && (e as Error).name !== "AbortError" && setErr(true),
      );
    setData(null);
    setHover(null);
    void load();
    const id = setInterval(() => void load(), REFRESH_MS[range]);
    return () => {
      live = false;
      ac.abort();
      clearInterval(id);
    };
  }, [assetRef, range]);

  const pts = useMemo(() => (data?.points ?? []).map((p) => ({ t: Date.parse(p.t), v: Number(p.usd), ext: !!p.ext })), [data]);
  const change = data?.changePct != null ? Number(data.changePct) : null;
  const color = change === null ? "var(--text-3)" : change >= 0 ? "var(--ok)" : "var(--bad)";

  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const vs = pts.map((p) => p.v);
    let lo = Math.min(...vs);
    let hi = Math.max(...vs);
    if (hi === lo) {
      hi += hi * 0.001 || 1;
      lo -= lo * 0.001 || 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const iw = width - PAD.left - PAD.right;
    const ih = H - PAD.top - PAD.bottom;
    // Points are evenly spaced (share bars within sessions, or resampled buckets): x by index.
    const x = (i: number) => PAD.left + (i / (pts.length - 1)) * iw;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * ih;
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    const area = `${line}L${x(pts.length - 1).toFixed(1)},${PAD.top + ih}L${x(0).toFixed(1)},${PAD.top + ih}Z`;
    // Extended-hours stretches, drawn over the line in a fainter stroke.
    const ext: string[] = [];
    let seg = "";
    pts.forEach((p, i) => {
      if (p.ext) seg += `${seg ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`;
      else if (seg) (ext.push(seg), (seg = ""));
    });
    if (seg) ext.push(seg);
    const grid = [0.25, 0.5, 0.75].map((f) => lo + (hi - lo) * f);
    const ticks = [0, Math.floor((pts.length - 1) / 3), Math.floor(((pts.length - 1) * 2) / 3), pts.length - 1];
    return { x, y, line, area, ext, grid, ticks, iw, base: y(pts[0]!.v) };
  }, [pts, width]);

  const fmtTime = (ms: number) => {
    const d = new Date(ms);
    if (range === "1D") return d.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
    if (range === "1Y") return d.toLocaleDateString(lang, { month: "short", year: "2-digit" });
    return d.toLocaleDateString(lang, { day: "numeric", month: "short" });
  };
  const fmtFull = (ms: number) => new Date(ms).toLocaleString(lang, range === "1Y" ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  const onMove = (clientX: number, el: SVGSVGElement) => {
    if (!geo) return;
    const r = el.getBoundingClientRect();
    const i = Math.round(((clientX - r.left - PAD.left) / geo.iw) * (pts.length - 1));
    setHover(Math.max(0, Math.min(pts.length - 1, i)));
  };
  const sel = hover !== null ? pts[hover] : null;
  const shown = sel ? sel.v : pts.at(-1)?.v;
  const selChange = sel && pts[0] ? ((sel.v - pts[0].v) / pts[0].v) * 100 : change;

  return (
    <div className="pchart" ref={box}>
      <div className="pc-head">
        <div className="pc-read" aria-live="polite">
          {shown !== undefined && <span className="num pc-val">{usd(String(shown))}</span>}
          {selChange !== null && (
            <span className="num" style={{ color: selChange >= 0 ? "var(--ok)" : "var(--bad)" }}>
              {selChange >= 0 ? "+" : ""}
              {pct(selChange, 2)}
            </span>
          )}
          <span className="muted small">{sel ? fmtFull(sel.t) : t(`chart.period.${range}`)}</span>
        </div>
        <div className="seg" role="radiogroup" aria-label={t("chart.range")}>
          {RANGES.map((r) => (
            <button key={r} role="radio" aria-checked={range === r} className={range === r ? "on" : undefined} onClick={() => setRange(r)}>
              {t(`chart.r.${r}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="pc-plot" style={{ height: H }}>
        {!data && !err && <div className="skeleton" style={{ height: H - 20, marginTop: 10 }} />}
        {(err || (data && pts.length < 2)) && <div className="pc-empty muted small">{t("chart.none")}</div>}
        {geo && (
          <svg
            width={width}
            height={H}
            role="img"
            aria-label={t("chart.aria", { r: t(`chart.period.${range}`), c: change !== null ? pct(change, 2) : "—" })}
            onPointerMove={(e) => onMove(e.clientX, e.currentTarget)}
            onPointerDown={(e) => onMove(e.clientX, e.currentTarget)}
            onPointerLeave={() => setHover(null)}
            style={{ touchAction: "pan-y" }}
          >
            {geo.grid.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={PAD.left + geo.iw} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--border)" strokeWidth="1" />
                <text x={width - PAD.right + 8} y={geo.y(v) + 4} className="pc-axis">
                  {usd(String(v))}
                </text>
              </g>
            ))}
            <line x1={PAD.left} x2={PAD.left + geo.iw} y1={geo.base} y2={geo.base} stroke="var(--text-3)" strokeDasharray="2 4" strokeWidth="1" />
            <path d={geo.area} fill={color} fillOpacity="0.1" />
            <path d={geo.line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
            {geo.ext.map((d, i) => (
              <path key={i} d={d} fill="none" stroke="var(--bg)" strokeOpacity="0.55" strokeWidth="2.2" strokeLinejoin="round" />
            ))}
            {geo.ticks.map((i, k) => (
              <text key={k} x={geo.x(i)} y={H - 6} className="pc-axis" textAnchor={k === 0 ? "start" : k === geo.ticks.length - 1 ? "end" : "middle"}>
                {fmtTime(pts[i]!.t)}
              </text>
            ))}
            {sel && hover !== null && (
              <g>
                <line x1={geo.x(hover)} x2={geo.x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="var(--text-2)" strokeWidth="1" />
                <circle cx={geo.x(hover)} cy={geo.y(sel.v)} r="4.5" fill={color} stroke="var(--bg)" strokeWidth="2" />
              </g>
            )}
          </svg>
        )}
      </div>

      {data && (
        <div className="pc-foot faint small">
          {data.source.provider === "ROBINHOOD_MARKET_DATA"
            ? t("chart.src.rh", { s: data.source.symbol, m: Number(data.source.multiplier).toFixed(4) })
            : t("chart.src.cl", { f: data.source.feed })}
          {data.high && data.low && ` · ${t("chart.hl", { h: usd(data.high), l: usd(data.low) })}`}
          {data.since && ` · ${t("chart.since", { d: date(data.since) })}`}
          {pts.some((p) => p.ext) && ` · ${t("chart.ext")}`}
          {` · ${t("chart.updated", { x: ago(t, data.generatedAt) })}`}
        </div>
      )}
    </div>
  );
}
