import { useId, useMemo, useState } from "react";
import { api } from "../api";
import { pct, usd } from "../format";
import { useI18n } from "../i18n";
import { ago } from "../text";
import { useAsync } from "./common";

const W = 280;
const H = 64;

/** Sparkline of the asset's last Chainlink updates (not a fixed time window: feeds update on deviation/heartbeat). */
export function PriceChart({ assetRef }: { assetRef: string }) {
  const { t } = useI18n();
  const res = useAsync((s) => api.history(assetRef, s), [assetRef]);
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();
  const h = res.data;
  const pts = useMemo(() => (h?.points ?? []).map((p) => ({ t: Date.parse(p.t), v: Number(p.usd), raw: p })), [h]);
  if (res.error || !h || pts.length < 2) return null;

  const t0 = pts[0]!.t;
  const t1 = pts.at(-1)!.t;
  const vs = pts.map((p) => p.v);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const x = (tt: number) => (t1 === t0 ? 0 : ((tt - t0) / (t1 - t0)) * W);
  const y = (v: number) => (hi === lo ? H / 2 : H - 4 - ((v - lo) / (hi - lo)) * (H - 8));
  const path = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const change = h.change ? Number(h.change.pct) : 0;
  const color = change > 0 ? "var(--ok)" : change < 0 ? "var(--bad)" : "var(--text-3)";
  const sel = hover !== null ? pts[hover] : null;

  return (
    <figure className="chart" aria-labelledby={id}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        role="img"
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const tt = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
          let best = 0;
          for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i]!.t - tt) < Math.abs(pts[best]!.t - tt)) best = i;
          setHover(best);
        }}
      >
        <path d={path} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" />
        {sel && <circle cx={x(sel.t)} cy={y(sel.v)} r="3" fill={color} />}
      </svg>
      <figcaption id={id} className="small muted">
        {sel ? (
          <>
            {usd(sel.raw.usd)} · {ago(t, sel.raw.t)}
          </>
        ) : (
          <>
            <span style={{ color, fontWeight: 600 }}>
              {change > 0 ? "+" : ""}
              {pct(change, 2)}
            </span>{" "}
            · {t("chart.caption", { n: pts.length, since: ago(t, h.points[0]!.t) })}
          </>
        )}
      </figcaption>
    </figure>
  );
}
