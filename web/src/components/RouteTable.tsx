import { Fragment, useState } from "react";
import type { Card } from "../api";
import { amount, feePpm, pctE18, usd } from "../format";
import { useI18n } from "../i18n";
import { code } from "../text";
import { ExplorerLink, ProtocolLink, UsabilityBadge } from "./common";
import { rowKeys } from "./keyboard";
import { canSwap, SwapDialog } from "./SwapDialog";

/** Venue of a market from its id (`4663:<protocol>:<venueKind>:<pool>`). */
export function venueOf(marketId: string): string {
  const p = marketId.split(":")[1] ?? "";
  return p === "uniswap" ? "Uniswap v3" : p === "uniswap-v4" ? "Uniswap v4" : p === "ramses" ? "Ramses" : p;
}

/** Compact, ranked list of trade routes (with quotes when an amount was given). Rows expand to pool detail. */
export function RouteTable({ cards }: { cards: Card[] }) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  const [swapping, setSwapping] = useState<Card | null>(null);
  const quoted = cards.some((c) => c.trade?.quote);
  const hasVol = cards.some((c) => c.trade?.route.markets.some((m) => m.volume24h));
  // Route volume shown as the smallest hop volume (the bottleneck), when every hop has one.
  const routeVol = (c: Card) => {
    const v = c.trade!.route.markets.map((m) => m.volume24h?.usd ?? null);
    return v.every((x) => x !== null) ? Math.min(...(v as number[])) : null;
  };
  return (
    <div className="panel table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th style={{ width: 28 }}>#</th>
            <th>{t("route.route")}</th>
            {quoted && <th style={{ textAlign: "right" }}>{t("route.youGet")}</th>}
            {quoted && <th style={{ textAlign: "right" }}>{t("route.impact")}</th>}
            <th style={{ textAlign: "right" }}>{t("route.fees")}</th>
            <th style={{ textAlign: "right" }}>{t("route.thinnest")}</th>
            {hasVol && (
              <th style={{ textAlign: "right" }} title={t("route.volumeTitle")}>
                {t("route.volume")}
              </th>
            )}
            <th>{t("route.status")}</th>
            <th aria-label={t("route.details")} />
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => {
            const tr = c.trade!;
            const q = tr.quote;
            const isOpen = open === c.cardId;
            const toggle = () => setOpen(isOpen ? null : c.cardId);
            const cols = 6 + (quoted ? 2 : 0) + (hasVol ? 1 : 0);
            return (
              <Fragment key={c.cardId}>
                <tr className="clickable" onClick={toggle} {...rowKeys(toggle)} aria-expanded={isOpen}>
                  <td className="faint num">{c.ranking?.position}</td>
                  <td>
                    <span className="path" style={{ fontWeight: 600 }}>
                      {tr.route.path.map((a, i) => (
                        <Fragment key={a.key + i}>
                          {i > 0 && <span className="arrow">→</span>}
                          {a.symbol}
                        </Fragment>
                      ))}
                    </span>
                    <div className="small faint">{[...new Set(tr.route.markets.map((m) => venueOf(m.marketId)))].join(" + ")}</div>
                  </td>
                  {quoted && (
                    <td className="num" style={{ textAlign: "right", fontWeight: 600 }}>
                      {q ? `${amount(q.expectedOutput.display)} ${q.expectedOutput.asset.symbol}` : "·"}
                    </td>
                  )}
                  {quoted && (
                    <td className="num" style={{ textAlign: "right" }}>
                      {q?.priceImpact != null ? pctE18(q.priceImpact) : "·"}
                    </td>
                  )}
                  <td className="num" style={{ textAlign: "right" }}>
                    {feePpm(tr.route.combinedFeePpm)}
                  </td>
                  <td className="num" style={{ textAlign: "right" }}>
                    {usd(tr.route.routeLiquidityUsd?.display, { compact: true })}
                  </td>
                  {hasVol && (
                    <td className="num" style={{ textAlign: "right" }}>
                      {routeVol(c) !== null ? usd(String(routeVol(c)), { compact: true }) : "·"}
                    </td>
                  )}
                  <td>
                    <UsabilityBadge status={c.usability.status} />
                  </td>
                  <td className="faint" style={{ whiteSpace: "nowrap" }}>
                    {canSwap(c) && (
                      <button
                        className="btn small primary"
                        style={{ marginInlineEnd: 6 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSwapping(c);
                        }}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        {t("swap.button")}
                      </button>
                    )}
                    {isOpen ? "▾" : "▸"}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td />
                    <td colSpan={cols - 1} style={{ paddingTop: 0 }}>
                      <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
                        {c.usability.reasons.map((r) => (
                          <div key={r} style={{ color: "var(--warn)" }}>
                            {code(t, "reason", r)}
                          </div>
                        ))}
                        {tr.route.markets.map((m, i) => (
                          <div key={m.marketId} className="muted">
                            {t("card.pool", { n: i + 1 })}: {m.protocol} · {feePpm(m.feePpm)} · TVL {usd(m.tvlUsd?.display, { compact: true })}
                            {m.volume24h?.usd != null ? ` · ${t("route.vol24", { x: usd(String(m.volume24h.usd), { compact: true }) })}` : ""} ·{" "}
                            <ExplorerLink address={m.marketId.split(":").at(-1) ?? ""} />
                          </div>
                        ))}
                        {q && (
                          <div className="muted">
                            {t("route.quotedFor", { b: q.blockNumber, f: code(t, "fresh", q.freshness), x: `${amount(q.input.display)} ${q.input.asset.symbol}` })}
                          </div>
                        )}
                        {q && !canSwap(c) && <div className="faint">{t("swap.venueOnly")}</div>}
                        {c.protocolApp && <ProtocolLink name={c.protocol.name} url={c.protocolApp.url} />}
                        {tr.route.markets.some((m) => m.volume24h) && <div className="faint">{t("route.volumeSource")}</div>}
                        <div className="faint">
                          {[
                            ...c.usability.notes.map((n) => code(t, "note", n)),
                            t("route.sources", { s: c.sources.map((s) => s.provider).join(", ") }),
                            t("route.verification", { v: c.verification.replaceAll("_", " ").toLowerCase() }),
                          ].join(" · ")}
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
      {swapping && <SwapDialog card={swapping} onClose={() => setSwapping(null)} />}
    </div>
  );
}
