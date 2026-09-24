import type { Card } from "../api";
import { ago, amount, date, feePpm, pctE18, usd } from "../format";
import { NOTE_TEXT, REASON_TEXT } from "../text";
import { UsabilityBadge } from "./common";

const HEADLINE_LABEL: Record<string, string> = {
  SUPPLY_APY: "Supply APY",
  BORROW_APY: "Borrow APY",
  NET_APY: "Net APY",
  IMPLIED_APY: "Implied APY",
  YIELD_EXPOSURE_APY: "YT implied APY",
};

function reasonClass(status: string): string {
  return status === "HIDDEN_BY_DEFAULT" || status === "UNAVAILABLE" ? "bad" : status === "INFORMATIONAL" ? "info" : "";
}

/** One product card: action, headline, liquidity, usability with reasons, and expandable provenance. */
export function CardView({ card, showRank = true }: { card: Card; showRank?: boolean }) {
  const h = card.headline;
  const t = card.trade;
  const q = t?.quote ?? null;
  return (
    <article className="panel card">
      <div className="top">
        {showRank && card.ranking && <span className="rank num">{card.ranking.position}</span>}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="label">{card.actionLabel}</div>
          <div className="ctx">
            {card.protocol.name}
            {card.context ? ` · ${card.context}` : ""}
          </div>
        </div>
        <UsabilityBadge status={card.usability.status} />
      </div>

      {t ? (
        <div className="path">
          {t.route.path.map((a, i) => (
            <span key={a.key + i} className="row" style={{ gap: 6 }}>
              {i > 0 && <span className="arrow">→</span>}
              {a.symbol}
            </span>
          ))}
          <span className="chip">{t.route.kind === "DIRECT" ? "direct" : "1 hop"}</span>
        </div>
      ) : null}

      <div className="metric">
        {h && (
          <div>
            <div className="v num">{h.display}</div>
            <div className="l">
              {HEADLINE_LABEL[h.type] ?? h.type}
              {h.basis === "VARIABLE" ? " · variable" : ""}
            </div>
          </div>
        )}
        {q && (
          <div>
            <div className="v num">
              {amount(q.expectedOutput.display)} <span style={{ fontSize: 14 }}>{q.expectedOutput.asset.symbol}</span>
            </div>
            <div className="l">Indicative output for {amount(q.input.display)} {q.input.asset.symbol}</div>
          </div>
        )}
        {q && (
          <div>
            <div className="v num">{q.priceImpact === null ? "—" : pctE18(q.priceImpact)}</div>
            <div className="l">Price impact · {q.priceImpactClass.toLowerCase()}</div>
          </div>
        )}
        {t && (
          <div>
            <div className="v num">{feePpm(t.route.combinedFeePpm)}</div>
            <div className="l">Pool fees</div>
          </div>
        )}
        <div>
          <div className="v num">{usd(t ? t.route.routeLiquidityUsd?.display : card.liquidity?.usd?.display, { compact: true })}</div>
          <div className="l">{t ? "Thinnest pool TVL" : card.subcategory === "COLLATERAL" ? "Available to borrow" : "Liquidity"}</div>
        </div>
        {card.fixedYield?.maturity && (
          <div>
            <div className="v num">{date(card.fixedYield.maturity)}</div>
            <div className="l">Maturity · {card.fixedYield.daysToMaturity} days</div>
          </div>
        )}
        {card.lltv && (
          <div>
            <div className="v num">{pctE18(card.lltv, 1)}</div>
            <div className="l">Liquidation LTV</div>
          </div>
        )}
      </div>

      {card.borrowCapacity?.maxBorrow && (
        <div className="small">
          <span className="muted">Theoretical limit for your balance: </span>
          <strong className="num">
            {amount(card.borrowCapacity.maxBorrow.amount.display)} {card.borrowCapacity.maxBorrow.asset.symbol}
          </strong>
          {card.borrowCapacity.maxBorrow.usd && card.liquidity?.usd && Number(card.borrowCapacity.maxBorrow.usd.display) > Number(card.liquidity.usd.display) && (
            <div style={{ color: "var(--warn)" }}>The market can lend only {usd(card.liquidity.usd.display)} right now, far less than this limit.</div>
          )}
          <div className="faint">Borrowing this much is liquidatable on the next adverse move. Not a recommended amount.</div>
        </div>
      )}

      {card.usability.reasons.length > 0 && (
        <ul className="reasons">
          {card.usability.reasons.map((r) => (
            <li key={r} className={reasonClass(card.usability.status)}>
              {REASON_TEXT[r] ?? r}
            </li>
          ))}
        </ul>
      )}
      {card.usability.notes.length > 0 && (
        <div className="notes">
          {card.usability.notes.map((n) => (
            <span key={n} className="chip">
              {NOTE_TEXT[n] ?? n}
            </span>
          ))}
        </div>
      )}

      <details className="more">
        <summary>Details and sources</summary>
        <div className="body">
          {card.fixedYield && (
            <ul style={{ margin: 0, paddingLeft: 18 }} className="muted">
              {card.fixedYield.conditions.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          <dl className="kv">
            {card.metrics
              .filter((m) => m.type !== h?.type)
              .map((m) => (
                <MetricRow key={m.type + m.label} label={m.label} value={m.display} />
              ))}
            {h && <MetricRow label="Headline observed" value={`${ago(h.observedAt)} · ${h.freshness.toLowerCase()}`} />}
            {card.tvlUsd && <MetricRow label="TVL" value={usd(card.tvlUsd.display)} />}
            {t &&
              t.route.markets.map((m, i) => (
                <MetricRow key={m.marketId} label={`Pool ${i + 1}`} value={`${m.protocol} · fee ${feePpm(m.feePpm)} · TVL ${usd(m.tvlUsd?.display, { compact: true })}`} />
              ))}
            {q && <MetricRow label="Quoted at block" value={`${q.blockNumber} · ${q.freshness.toLowerCase()} · not a guaranteed price`} />}
            {t && <MetricRow label="24h volume" value="not measured" />}
            <MetricRow label="Verification" value={card.verification.replaceAll("_", " ").toLowerCase()} />
            <MetricRow label="Sources" value={card.sources.map((s) => `${s.provider} (${s.type.toLowerCase()})`).join(", ")} />
            {card.ranking && <MetricRow label="Ordering" value={`${card.ranking.comparator} · #${card.ranking.position}`} />}
            <MetricRow label="Card id" value={<span className="mono">{card.cardId}</span>} />
          </dl>
        </div>
      </details>
    </article>
  );
}

function MetricRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
