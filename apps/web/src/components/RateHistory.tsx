import { useEffect, useState } from "react";
import { pct } from "../format";
import { useI18n } from "../i18n";
import { ago } from "../text";

interface Hist {
  points: { t: number; v: string; tvl: string | null }[];
  recordingSince: string | null;
  everyMinutes: number;
}

/** Locally recorded headline-rate history for one opportunity (fetched when shown). */
export function RateHistory({ opportunityId }: { opportunityId: string }) {
  const { t } = useI18n();
  const [h, setH] = useState<Hist | null | "none">(null);
  useEffect(() => {
    const ac = new AbortController();
    fetch(`/api/rates/history?id=${encodeURIComponent(opportunityId)}`, { signal: ac.signal, credentials: "omit" })
      .then((r) => (r.ok ? (r.json() as Promise<Hist>) : null))
      .then((j) => setH(j ?? "none"))
      .catch(() => !ac.signal.aborted && setH("none"));
    return () => ac.abort();
  }, [opportunityId]);
  if (h === null) return null;
  if (h === "none" || h.points.length < 2) {
    return <div className="faint small">{h !== "none" && h.recordingSince ? t("rates.tooFew", { since: ago(t, h.recordingSince) }) : t("rates.none")}</div>;
  }
  const W = 220;
  const H = 40;
  const vs = h.points.map((p) => Number(p.v) / 1e16);
  const ts = h.points.map((p) => p.t);
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  const x = (tt: number) => ((tt - ts[0]!) / Math.max(1, ts.at(-1)! - ts[0]!)) * W;
  const y = (v: number) => (hi === lo ? H / 2 : H - 3 - ((v - lo) / (hi - lo)) * (H - 6));
  const d = h.points.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(vs[i]!).toFixed(1)}`).join(" ");
  return (
    <div className="small">
      <div className="muted">{t("rates.title", { since: ago(t, new Date(ts[0]!).toISOString()), n: h.points.length })}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={t("rates.aria", { lo: pct(lo), hi: pct(hi) })}>
        <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.6" />
      </svg>
      <div className="faint">
        {t("rates.range", { lo: pct(lo), hi: pct(hi) })} · {t("rates.note", { m: h.everyMinutes })}
      </div>
    </div>
  );
}
