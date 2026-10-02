import { Fragment, useMemo, useState } from "react";
import type { Card } from "../api";
import { pctText, usd } from "../format";
import { useI18n } from "../i18n";
import { actionLabel, contextLine } from "../text";
import { CardView } from "./CardView";
import { UsabilityBadge } from "./common";
import { rowKeys } from "./keyboard";

const MIN_LIQ = [0, 1_000, 10_000, 100_000] as const;

/** Compact, filterable list for long subcategories (e.g. 46 USDG lending markets). Rows expand to the full card. */
export function OpportunityTable({ cards }: { cards: Card[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const [minLiq, setMinLiq] = useState<number>(0);
  const [protocol, setProtocol] = useState<string>("ALL");
  const protocols = useMemo(() => [...new Set(cards.map((c) => c.protocol.name))].sort(), [cards]);
  const rows = cards.filter((c) => (protocol === "ALL" || c.protocol.name === protocol) && (minLiq === 0 || Number(c.liquidity?.usd?.display ?? 0) >= minLiq));
  return (
    <>
      <div className="row" style={{ margin: "0 0 8px" }}>
        <label className="toggle">
          {t("table.minLiq")}
          <select className="input" value={minLiq} onChange={(e) => setMinLiq(Number(e.target.value))}>
            {MIN_LIQ.map((v) => (
              <option key={v} value={v}>
                {v === 0 ? t("table.any") : `≥ ${usd(String(v), { compact: true })}`}
              </option>
            ))}
          </select>
        </label>
        {protocols.length > 1 && (
          <label className="toggle">
            {t("table.protocol")}
            <select className="input" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              <option value="ALL">{t("table.any")}</option>
              {protocols.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="spacer" />
        <span className="small muted">{t("coverage.of", { a: rows.length, b: cards.length })}</span>
      </div>
      <div className="panel table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th style={{ width: 28 }}>#</th>
              <th>{t("table.opportunity")}</th>
              <th style={{ textAlign: "right" }}>{t("table.rate")}</th>
              <th style={{ textAlign: "right" }}>{t("card.liquidity")}</th>
              <th>{t("route.status")}</th>
              <th aria-label={t("route.details")} />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted small">
                  {t("table.noneMatch")}
                </td>
              </tr>
            )}
            {rows.map((c) => {
              const isOpen = open === c.cardId;
              const toggle = () => setOpen(isOpen ? null : c.cardId);
              return (
                <Fragment key={c.cardId}>
                  <tr className="clickable" onClick={toggle} {...rowKeys(toggle)} aria-expanded={isOpen}>
                    <td className="faint num">{c.ranking?.position}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{actionLabel(t, c)}</div>
                      <div className="small muted">{contextLine(t, c)}</div>
                    </td>
                    <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>
                      {c.headline ? pctText(c.headline.display) : "·"}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {usd(c.liquidity?.usd?.display, { compact: true })}
                    </td>
                    <td>
                      <UsabilityBadge status={c.usability.status} />
                    </td>
                    <td className="faint">{isOpen ? "▾" : "▸"}</td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={6} style={{ padding: 12, background: "var(--surface-2)" }}>
                        <CardView card={c} showRank={false} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
