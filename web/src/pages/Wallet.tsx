import { useState } from "react";
import { api, type Intelligence, type Portfolio } from "../api";
import { CardView } from "../components/CardView";
import { Avatar, ErrorBox, ExplorerLink, LoadingCards, useAsync } from "../components/common";
import { amount, date, pctE18, shortAddr, usd } from "../format";
import { useI18n } from "../i18n";
import { linkProps, navigate } from "../router";
import { code } from "../text";
import { useWallet } from "../wallet";
import { ProtocolLogo } from "../components/icons";

const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;

export function WalletPage() {
  const { t } = useI18n();
  const w = useWallet();
  if (!w.address) return <PortfolioEmpty />;
  return <WalletView key={w.address} address={w.address} />;
}

/** Before a wallet is connected: one clear action, an address fallback, and what the page will show. */
function PortfolioEmpty() {
  const { t } = useI18n();
  const w = useWallet();
  const [text, setText] = useState("");
  const feats = [
    { icon: "◐", title: t("pf.f1t"), body: t("pf.f1d") },
    { icon: "↗", title: t("pf.f2t"), body: t("pf.f2d") },
    { icon: "▤", title: t("pf.f3t"), body: t("pf.f3d") },
  ];
  return (
    <div className="pf-empty">
      <div className="panel pf-card">
        <div className="pf-icon" aria-hidden="true">
          ◎
        </div>
        <h1>{t("pf.title")}</h1>
        <p className="muted">{t("pf.lead")}</p>
        <button className="btn primary big" disabled={w.connecting} onClick={w.openPicker}>
          {w.connecting ? t("walletEntry.waiting") : t("walletEntry.use")}
        </button>
        <div className="pf-or">
          <span>{t("pf.or")}</span>
        </div>
        <form
          className="pf-addr"
          onSubmit={(e) => {
            e.preventDefault();
            if (w.usePasted(text)) navigate("/wallet");
          }}
        >
          <label className="sr-only" htmlFor="addr">
            {t("walletEntry.label")}
          </label>
          <input id="addr" className="input mono" placeholder={t("walletEntry.placeholder")} spellCheck={false} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn" type="submit">
            {t("walletEntry.view")}
          </button>
        </form>
        {w.error && <div className="small" style={{ color: "var(--bad)" }}>{t(w.error)}</div>}
        <div className="faint small">{t("walletEntry.footnote")}</div>
      </div>
      <div className="pf-feats">
        {feats.map((f) => (
          <div key={f.title} className="pf-feat">
            <span className="ico" aria-hidden="true">
              {f.icon}
            </span>
            <div className="t">{f.title}</div>
            <div className="muted small">{f.body}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function WalletView({ address }: { address: string }) {
  const { t } = useI18n();
  const w = useWallet();
  const res = useAsync((s) => api.portfolio(address, s), [address]);
  const p = res.data;
  const [open, setOpen] = useState<string | null>(null);
  // Largest holdings first; unpriced last.
  const assets = p ? [...p.assets].sort((a, b) => Number(b.balance?.valueUsd?.display ?? -1) - Number(a.balance?.valueUsd?.display ?? -1)) : [];

  return (
    <>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div>
          <div className="muted small">{w.source === "connected" ? t("wallet.connected") : t("wallet.pasted")}</div>
          <h1 className="mono" style={{ fontSize: 24 }} title={address}>
            {shortAddr(address)}
          </h1>
        </div>
        <span className="spacer" />
        <button className="btn small" onClick={res.reload} disabled={res.loading}>
          {t("wallet.refresh")}
        </button>
        <button className="btn small ghost" onClick={w.clear}>
          {t("wallet.forget")}
        </button>
      </div>

      {res.error && (
        <div style={{ marginTop: 16 }}>
          <ErrorBox error={res.error} onRetry={res.reload} />
        </div>
      )}
      {!p && !res.error && (
        <div className="section">
          <LoadingCards n={4} />
        </div>
      )}
      {p && (
        <>
          <div className="grid four" style={{ marginTop: 18 }}>
            <div className="panel stat">
              <div className="v num">{usd(p.pricedValueUsd)}</div>
              <div className="l">
                {t("wallet.priced")}
                {p.unpricedAssetCount ? ` ${t("wallet.unpricedPlus", { n: p.unpricedAssetCount })}` : ""}
              </div>
            </div>
            <div className="panel stat">
              <div className="v num">{usd(p.supportedAssetValueUsd)}</div>
              <div className="l">{t("wallet.supported")}</div>
            </div>
            <div className="panel stat">
              <div className="v num">{usd(p.unsupportedAssetValueUsd)}</div>
              <div className="l">{t("wallet.unsupported")}</div>
            </div>
            <div className="panel stat">
              <div className="v num">{p.opportunityCounts.actionable + p.opportunityCounts.limited}</div>
              <div className="l">{t("wallet.opps")}</div>
            </div>
          </div>
          {p.dataQuality.status !== "COMPLETE" && (
            <p className="small" style={{ color: "var(--warn)" }}>
              {t(`quality.${p.dataQuality.status}`)}: {p.dataQuality.reasons.map((r) => r.detail ?? r.code).join("; ")}
            </p>
          )}

          <Positions positions={p.positions} />

          <section className="section">
            <div className="section-head">
              <h2>{t("wallet.holdings")}</h2>
              <span className="muted">{t("wallet.holdingsHint")}</span>
            </div>
            {assets.length === 0 && <div className="panel empty">{t("wallet.noAssets")}</div>}
            <div style={{ display: "grid", gap: 10 }}>
              {assets.map((a) => (
                <Holding key={a.asset?.key} a={a} open={open === a.asset?.key} toggle={() => setOpen(open === a.asset?.key ? null : (a.asset?.key ?? null))} />
              ))}
            </div>
            {p.unsupportedAssets.length > 0 && (
              <div className="panel pad" style={{ marginTop: 12 }}>
                <h3>{t("wallet.notCovered")}</h3>
                <ul className="small muted" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {p.unsupportedAssets.map((u) => (
                    <li key={u.asset.key}>
                      {u.asset.symbol}: {u.reason.startsWith("native") ? t("wallet.reason.native") : u.reason === "non-canonical asset" ? t("wallet.reason.nonCanonical") : u.reason}
                      {u.valueUsd ? ` (${usd(u.valueUsd)})` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

type PositionV = Portfolio["positions"][number];

function Positions({ positions }: { positions: PositionV[] }) {
  const { t } = useI18n();
  const amt = (x: PositionV["supplied"]) => (x ? `${amount(x.amount?.display ?? null)} ${x.asset.symbol}${x.usd ? ` · ${usd(x.usd.display)}` : ""}` : null);
  return (
    <section className="section">
      <div className="section-head">
        <h2>{t("pos.title")}</h2>
        <span className="muted">{t("pos.hint")}</span>
      </div>
      {positions.length === 0 ? (
        <div className="panel pad muted small">{t("pos.none")}</div>
      ) : (
        <div className="grid two">
          {positions.map((p) => {
            const hf = p.healthFactor !== null ? Number(p.healthFactor) / 1e18 : null;
            const hfColor = hf === null ? undefined : hf < 1.05 ? "var(--bad)" : hf < 1.25 ? "var(--warn)" : "var(--ok)";
            return (
              <article key={p.id} className="panel card">
                <div className="top">
                  <ProtocolLogo name={p.protocol.name} size={34} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="label">{t(`pos.kind.${p.kind}`)}</div>
                    <div className="ctx">
                      {p.protocol.name}
                      {p.label ? ` · ${p.label}` : ""}
                    </div>
                  </div>
                  {p.liquidatable === true && <span className="badge HIDDEN_BY_DEFAULT">{t("pos.liquidatable")}</span>}
                </div>
                <dl className="kv">
                  {p.supplied && (
                    <>
                      <dt>{t("pos.supplied")}</dt>
                      <dd className="num">{amt(p.supplied)}</dd>
                    </>
                  )}
                  {p.collateral && (
                    <>
                      <dt>{t("pos.collateral")}</dt>
                      <dd className="num">{amt(p.collateral)}</dd>
                    </>
                  )}
                  {p.borrowed && (
                    <>
                      <dt>{t("pos.borrowed")}</dt>
                      <dd className="num">{amt(p.borrowed)}</dd>
                    </>
                  )}
                  {hf !== null && (
                    <>
                      <dt>{t("pos.health")}</dt>
                      <dd className="num" style={{ color: hfColor, fontWeight: 600 }}>
                        {amount(String(hf), 3)}
                      </dd>
                    </>
                  )}
                  {p.ltv !== null && (
                    <>
                      <dt>{t("pos.ltv")}</dt>
                      <dd className="num">
                        {pctE18(p.ltv, 1)}
                        {p.liquidationLtv ? ` / ${t("pos.lltv")} ${pctE18(p.liquidationLtv, 1)}` : ""}
                      </dd>
                    </>
                  )}
                  {p.maturity && (
                    <>
                      <dt>{p.maturity.expired ? t("pos.matured", { d: "" }) : t("pos.maturity", { d: "" })}</dt>
                      <dd>{date(p.maturity.at)}</dd>
                    </>
                  )}
                </dl>
                {p.liquidatable === false && p.borrowed && <div className="small" style={{ color: "var(--ok)" }}>{t("pos.healthy")}</div>}
                {p.venueAddress && <ExplorerLink address={p.venueAddress} />}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Holding({ a, open, toggle }: { a: Intelligence; open: boolean; toggle: () => void }) {
  const { t } = useI18n();
  const d = a.summary.capabilities.detail;
  const cards = a.categories.flatMap((c) => c.subcategories.flatMap((s) => (s.subcategory === "TRADE" ? [] : s.cards.slice(0, 2))));
  return (
    <div className="panel">
      <button className="holding" onClick={toggle} aria-expanded={open}>
        <Avatar symbol={a.asset?.symbol ?? "?"} address={a.asset?.address ?? null} />
        <div style={{ minWidth: 120 }}>
          <div style={{ fontWeight: 650 }}>{a.asset?.symbol}</div>
          <div className="small muted">{code(t, "type", a.asset?.registryType)}</div>
        </div>
        <div className="num" style={{ minWidth: 150 }}>
          <div>{t("wallet.tokens", { x: amount(a.balance?.displayBalance) })}</div>
          {a.balance?.stock && <div className="small faint">{t("wallet.shares", { x: amount(a.balance.stock.displayShareBalance) })}</div>}
        </div>
        <div className="num" style={{ minWidth: 90 }}>
          {usd(a.balance?.valueUsd?.display ?? null)}
        </div>
        <span className="spacer" />
        <div className="row" style={{ gap: 12 }}>
          {CATS.map((c) => (
            <span key={c} className="row small" style={{ gap: 5 }} title={t(`cap.${d[c]}`)}>
              <span className={`dot ${d[c]}`} />
              {t(`cat.${c}`)}
            </span>
          ))}
        </div>
        <span className="faint">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px", display: "grid", gap: 12 }}>
          {cards.length === 0 ? (
            <div className="muted small">{t("wallet.noOptions")}</div>
          ) : (
            <div className="grid two">
              {cards.map((c) => (
                <CardView key={c.cardId} card={c} showRank={false} />
              ))}
            </div>
          )}
          <div>
            <a className="btn small" {...linkProps(`/asset/${a.asset?.address ?? a.asset?.symbol}`)}>
              {t("wallet.allFor", { s: a.asset?.symbol ?? "" })}
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
