import { useState } from "react";
import { useAlerts, type AlertKind } from "../alerts";
import { pct, usd } from "../format";
import { useI18n } from "../i18n";
import { linkProps } from "../router";

/** Inline "alert me when …" form for a price (asset) or a headline rate (card). */
export function AlertForm({ kind, assetRef, symbol, cardId, label, current }: { kind: AlertKind; assetRef: string; symbol: string; cardId?: string; label: string; current: number | null }) {
  const { t } = useI18n();
  const al = useAlerts();
  const [op, setOp] = useState<"ABOVE" | "BELOW">("BELOW");
  const [value, setValue] = useState(current !== null ? String(Math.round(current * 100) / 100) : "");
  const [done, setDone] = useState(false);
  const n = Number(value);
  const valid = /^\d+(\.\d+)?$/.test(value) && n > 0 && value.length <= 20;
  if (done)
    return (
      <div className="small" style={{ color: "var(--ok)" }}>
        {t("alert.saved")} <a {...linkProps("/#alerts")}>{t("alert.manage")}</a>
      </div>
    );
  return (
    <form
      className="row small"
      style={{ gap: 8 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const shown = kind === "PRICE" ? usd(value) : pct(n);
        al.add({ kind, assetRef: assetRef.toLowerCase(), symbol, ...(cardId ? { cardId } : {}), label: t(op === "ABOVE" ? "alert.labelAbove" : "alert.labelBelow", { what: label, x: shown }), op, threshold: n });
        setDone(true);
      }}
    >
      <span className="muted">{t("alert.when", { what: label })}</span>
      <select className="input" value={op} onChange={(e) => setOp(e.target.value as "ABOVE" | "BELOW")} aria-label={t("alert.direction")}>
        <option value="ABOVE">{t("alert.above")}</option>
        <option value="BELOW">{t("alert.below")}</option>
      </select>
      <input className="input num" style={{ width: 110 }} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} aria-label={kind === "PRICE" ? t("alert.priceUsd") : t("alert.ratePct")} aria-invalid={!valid} />
      <span className="muted">{kind === "PRICE" ? "USD" : "%"}</span>
      <button className="btn small" disabled={!valid || al.alerts.length >= 20}>
        {t("alert.create")}
      </button>
    </form>
  );
}

/** Manage all alerts (home page). */
export function AlertList() {
  const { t } = useI18n();
  const al = useAlerts();
  if (!al.alerts.length) return null;
  return (
    <section className="section" id="alerts">
      <div className="section-head">
        <h2>{t("alert.title")}</h2>
        <span className="muted">{t("alert.hint")}</span>
      </div>
      <div className="panel table-wrap">
        <table className="data">
          <tbody>
            {al.alerts.map((a) => (
              <tr key={a.id}>
                <td>
                  <a {...linkProps(`/asset/${a.assetRef}`)} style={{ fontWeight: 600, color: "var(--text)" }}>
                    {a.symbol}
                  </a>
                </td>
                <td>{a.label}</td>
                <td className="num muted">{a.lastValue !== undefined ? (a.kind === "PRICE" ? usd(String(a.lastValue)) : pct(a.lastValue)) : "·"}</td>
                <td>{a.triggeredAt ? <span className="badge LIMITED">{t("alert.triggered")}</span> : <span className="badge ACTIONABLE">{t("alert.armed")}</span>}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {a.triggeredAt && (
                    <button className="btn small ghost" onClick={() => al.rearm(a.id)}>
                      {t("alert.rearm")}
                    </button>
                  )}
                  <button className="btn small ghost" onClick={() => al.remove(a.id)}>
                    {t("alert.remove")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Banner for alerts that fired while the app was open. */
export function FiredBanner() {
  const { t } = useI18n();
  const al = useAlerts();
  if (!al.fired.length) return null;
  return (
    <div className="notice warn" role="status" style={{ marginBottom: 16 }}>
      <span>
        <strong>{t("alert.firedTitle")}</strong> {al.fired.map((a) => `${a.symbol}: ${a.label}`).join(" · ")}
      </span>
      <span className="spacer" />
      <button className="btn small" onClick={al.dismissFired}>
        {t("alert.dismiss")}
      </button>
    </div>
  );
}
