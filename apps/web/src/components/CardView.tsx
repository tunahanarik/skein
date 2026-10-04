import { useState, type ReactNode } from "react";
import type { Card } from "../api";
import { amount, date, feePpm, humanDates, pctE18, pctText, prettyId, usd } from "../format";
import { useI18n, type StringKey } from "../i18n";
import { actionLabel, ago, code, contextLine } from "../text";
import { ProtocolLink, UsabilityBadge } from "./common";
import { ProtocolLogo } from "./icons";
import { Estimate } from "./Estimate";
import { AlertForm } from "./AlertForm";
import { RateHistory } from "./RateHistory";

const HEADLINE_LABEL: Record<string, StringKey> = {
  SUPPLY_APY: "card.supplyApy",
  BORROW_APY: "card.borrowApy",
  NET_APY: "card.netApy",
  IMPLIED_APY: "card.impliedApy",
  YIELD_EXPOSURE_APY: "card.ytApy",
};

function reasonClass(status: string): string {
  return status === "HIDDEN_BY_DEFAULT" || status === "UNAVAILABLE" ? "bad" : status === "INFORMATIONAL" ? "info" : "";
}

/** One product card: action, headline, liquidity, usability with reasons, and expandable provenance. */
export function CardView({ card, showRank = true }: { card: Card; showRank?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const h = card.headline;
  const tr = card.trade;
  const q = tr?.quote ?? null;
  const redemption = card.fixedYield?.conditions.find((c) => c.startsWith("Redemption:"));
  return (
    <article className="panel card">
      <div className="top">
        {showRank && card.ranking && <span className="rank num">{card.ranking.position}</span>}
        <ProtocolLogo name={card.protocol.name} size={34} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="label">{actionLabel(t, card)}</div>
          <div className="ctx">{contextLine(t, card)}</div>
        </div>
        <UsabilityBadge status={card.usability.status} />
      </div>

      {tr ? (
        <div className="path">
          {tr.route.path.map((a, i) => (
            <span key={a.key + i} className="row" style={{ gap: 6 }}>
              {i > 0 && <span className="arrow">→</span>}
              {a.symbol}
            </span>
          ))}
          <span className="chip">{tr.route.kind === "DIRECT" ? t("card.direct") : t("card.oneHop")}</span>
        </div>
      ) : null}

      <div className="metric">
        {h && (
          <div>
            {h.outlier ? (
              // Above 100 %: an unverified, usually thin-liquidity figure; named, never headlined.
              <div className="v" title={t("card.outlierNote", { v: h.display })}>
                <span className="badge HIDDEN_BY_DEFAULT">{t("card.outlier")}</span>
              </div>
            ) : (
              <div className="v num">{pctText(h.display)}</div>
            )}
            <div className="l">
              {HEADLINE_LABEL[h.type] ? t(HEADLINE_LABEL[h.type]!) : h.type}
              {h.basis === "VARIABLE" ? ` · ${t("card.variable")}` : ""}
              {h.outlier ? ` · ${t("card.outlierNote", { v: h.display })}` : ""}
            </div>
          </div>
        )}
        {q && (
          <div>
            <div className="v num">
              {amount(q.expectedOutput.display)} <span style={{ fontSize: 14 }}>{q.expectedOutput.asset.symbol}</span>
            </div>
            <div className="l">{t("card.outputFor", { x: `${amount(q.input.display)} ${q.input.asset.symbol}` })}</div>
          </div>
        )}
        {q && (
          <div>
            <div className="v num">{q.priceImpact === null ? "·" : pctE18(q.priceImpact)}</div>
            <div className="l">{t("card.impact", { c: code(t, "impact", q.priceImpactClass) })}</div>
          </div>
        )}
        {tr && (
          <div>
            <div className="v num">{feePpm(tr.route.combinedFeePpm)}</div>
            <div className="l">{t("card.fees")}</div>
          </div>
        )}
        <div>
          <div className="v num">{usd(tr ? tr.route.routeLiquidityUsd?.display : card.liquidity?.usd?.display, { compact: true })}</div>
          <div className="l">{tr ? t("card.thinnest") : card.subcategory === "COLLATERAL" ? t("card.availableBorrow") : t("card.liquidity")}</div>
        </div>
        {card.fixedYield?.maturity && (
          <div>
            <div className="v num">{date(card.fixedYield.maturity)}</div>
            <div className="l">{t("card.maturity", { n: amount(card.fixedYield.daysToMaturity, 1) })}</div>
          </div>
        )}
        {card.lltv && (
          <div>
            <div className="v num">{pctE18(card.lltv, 1)}</div>
            <div className="l">{t("card.lltv")}</div>
          </div>
        )}
      </div>

      {card.subcategory === "YIELD" && <div className="notice warn small"><span>{t("card.ytWarn")}</span></div>}
      {card.borrowCapacity?.borrowableNow && (
        <div className="small">
          <span className="muted">{t("card.borrowNow")} </span>
          <strong className="num">
            {amount(card.borrowCapacity.borrowableNow.amount.display)} {card.borrowCapacity.maxBorrow?.asset.symbol}
          </strong>{" "}
          <span className="faint">({card.borrowCapacity.borrowableNow.cappedBy === "MARKET_LIQUIDITY" ? t("card.cappedByMarket") : t("card.cappedByLimit")})</span>
        </div>
      )}
      {card.borrowCapacity?.maxBorrow && (
        <div className="small">
          <span className="muted">{t("card.limit")} </span>
          <strong className="num">
            {amount(card.borrowCapacity.maxBorrow.amount.display)} {card.borrowCapacity.maxBorrow.asset.symbol}
          </strong>
          <div className="faint">{t("card.limitWarn")}</div>
        </div>
      )}

      {card.usability.reasons.length > 0 && (
        <ul className="reasons">
          {card.usability.reasons.map((r) => (
            <li key={r} className={reasonClass(card.usability.status)}>
              {code(t, "reason", r)}
            </li>
          ))}
        </ul>
      )}
      {card.usability.notes.length > 0 && (
        <div className="notes">
          {card.usability.notes.map((n) => (
            <span key={n} className="chip">
              {code(t, "note", n)}
            </span>
          ))}
        </div>
      )}

      <Estimate card={card} />
      {card.protocolApp && <ProtocolLink name={card.protocol.name} url={card.protocolApp.url} />}
      <details className="more" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>{t("card.details")}</summary>
        <div className="body">
          {open && h && card.sourceOpportunityIds[0] && !tr && <RateHistory opportunityId={card.sourceOpportunityIds[0]} />}
          {open && h && !tr && <AlertForm kind="RATE" assetRef={card.asset.address} symbol={card.asset.symbol} cardId={card.cardId} label={`${actionLabel(t, card)} (${card.protocol.name})`} current={Number(h.value) / 1e16} />}
          {card.fixedYield && (
            <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
              <li>{t("card.cond1")}</li>
              <li>{t("card.cond2")}</li>
              {redemption && (
                <li>
                  {t("card.redemption")} <span className="faint">{humanDates(redemption.replace(/^Redemption:\s*/, ""))}</span>
                </li>
              )}
            </ul>
          )}
          <dl className="kv">
            {card.context && <Row label={t("card.context")} value={humanDates(card.context)} />}
            {card.metrics
              .filter((m) => m.type !== h?.type)
              .map((m) => (
                <Row key={m.type + m.label} label={HEADLINE_LABEL[m.type] ? t(HEADLINE_LABEL[m.type]!) : m.label} value={pctText(m.display)} />
              ))}
            {h && <Row label={t("card.observed")} value={`${ago(t, h.observedAt)} · ${code(t, "fresh", h.freshness)}`} />}
            {card.tvlUsd && <Row label={t("card.tvl")} value={usd(card.tvlUsd.display)} />}
            {tr &&
              tr.route.markets.map((m, i) => (
                <Row key={m.marketId} label={t("card.pool", { n: i + 1 })} value={`${m.protocol} · ${feePpm(m.feePpm)} · TVL ${usd(m.tvlUsd?.display, { compact: true })}`} />
              ))}
            {q && <Row label={t("card.quotedAt")} value={`${q.blockNumber} · ${code(t, "fresh", q.freshness)} · ${t("card.notGuaranteed")}`} />}
            {tr && <Row label={t("card.volume")} value={t("card.notMeasured")} />}
            <Row label={t("card.verification")} value={card.verification.replaceAll("_", " ").toLowerCase()} />
            <Row label={t("card.sources")} value={card.sources.map((s) => `${prettyId(s.provider)} (${prettyId(s.type.toLowerCase())})`).join(", ")} />
            {card.ranking && <Row label={t("card.ordering")} value={`${card.ranking.comparator} · #${card.ranking.position}`} />}
            <Row label={t("card.cardId")} value={<span className="mono">{card.cardId}</span>} />
          </dl>
        </div>
      </details>
    </article>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
