import { Fragment, useState } from "react";
import type { Card } from "../api";
import { amount, feePpm, pctE18, usd } from "../format";
import { NOTE_TEXT, REASON_TEXT } from "../text";
import { UsabilityBadge } from "./common";

/** Compact, ranked list of trade routes (with quotes when an amount was given). Rows expand to pool detail. */
export function RouteTable({ cards }: { cards: Card[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const quoted = cards.some((c) => c.trade?.quote);
  return (
    <div className="panel table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th style={{ width: 28 }}>#</th>
            <th>Route</th>
            {quoted && <th style={{ textAlign: "right" }}>You get (indicative)</th>}
            {quoted && <th style={{ textAlign: "right" }}>Price impact</th>}
            <th style={{ textAlign: "right" }}>Pool fees</th>
            <th style={{ textAlign: "right" }}>Thinnest pool</th>
            <th>Status</th>
            <th aria-label="Details" />
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => {
            const t = c.trade!;
            const q = t.quote;
            const isOpen = open === c.cardId;
            const cols = 6 + (quoted ? 2 : 0);
            return (
              <Fragment key={c.cardId}>
                <tr style={{ cursor: "pointer" }} onClick={() => setOpen(isOpen ? null : c.cardId)} aria-expanded={isOpen}>
                  <td className="faint num">{c.ranking?.position}</td>
                  <td>
                    <span className="path" style={{ fontWeight: 600 }}>
                      {t.route.path.map((a, i) => (
                        <Fragment key={a.key + i}>
                          {i > 0 && <span className="arrow">→</span>}
                          {a.symbol}
                        </Fragment>
                      ))}
                    </span>
                  </td>
                  {quoted && (
                    <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>
                      {q ? `${amount(q.expectedOutput.display)} ${q.expectedOutput.asset.symbol}` : "—"}
                    </td>
                  )}
                  {quoted && (
                    <td className="num" style={{ textAlign: "right" }}>
                      {q?.priceImpact != null ? pctE18(q.priceImpact) : "—"}
                    </td>
                  )}
                  <td className="num" style={{ textAlign: "right" }}>
                    {feePpm(t.route.combinedFeePpm)}
                  </td>
                  <td className="num" style={{ textAlign: "right" }}>
                    {usd(t.route.routeLiquidityUsd?.display, { compact: true })}
                  </td>
                  <td>
                    <UsabilityBadge status={c.usability.status} />
                  </td>
                  <td className="faint">{isOpen ? "▾" : "▸"}</td>
                </tr>
                {isOpen && (
                  <tr>
                    <td />
                    <td colSpan={cols - 1} style={{ paddingTop: 0 }}>
                      <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                        {c.usability.reasons.map((r) => (
                          <div key={r} style={{ color: "var(--warn)" }}>
                            {REASON_TEXT[r] ?? r}
                          </div>
                        ))}
                        {t.route.markets.map((m, i) => (
                          <div key={m.marketId} className="muted">
                            Pool {i + 1}: {m.protocol} · fee {feePpm(m.feePpm)} · TVL {usd(m.tvlUsd?.display, { compact: true })} ·{" "}
                            <span className="mono">{m.marketId.split(":").at(-1)}</span>
                          </div>
                        ))}
                        {q && (
                          <div className="muted">
                            Quoted at block {q.blockNumber} ({q.freshness.toLowerCase()}) for {amount(q.input.display)} {q.input.asset.symbol}. Not a guaranteed price; no minimum output.
                          </div>
                        )}
                        <div className="faint">
                          {[...c.usability.notes.map((n) => NOTE_TEXT[n] ?? n), `sources: ${c.sources.map((s) => s.provider).join(", ")}`, `verification: ${c.verification.replaceAll("_", " ").toLowerCase()}`].join(" · ")}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
