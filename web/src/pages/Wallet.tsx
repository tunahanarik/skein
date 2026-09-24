import { useState } from "react";
import { api, type Intelligence } from "../api";
import { CardView } from "../components/CardView";
import { Avatar, ErrorBox, LoadingCards, useAsync } from "../components/common";
import { amount, shortAddr, usd } from "../format";
import { useI18n } from "../i18n";
import { linkProps } from "../router";
import { code } from "../text";
import { useWallet } from "../wallet";
import { WalletEntry } from "./Home";

const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;

export function WalletPage() {
  const { t } = useI18n();
  const w = useWallet();
  if (!w.address) {
    return (
      <div style={{ maxWidth: 560 }}>
        <h1 style={{ marginBottom: 14 }}>{t("wallet.title")}</h1>
        <WalletEntry compact />
      </div>
    );
  }
  return <WalletView key={w.address} address={w.address} />;
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

function Holding({ a, open, toggle }: { a: Intelligence; open: boolean; toggle: () => void }) {
  const { t } = useI18n();
  const d = a.summary.capabilities.detail;
  const cards = a.categories.flatMap((c) => c.subcategories.flatMap((s) => (s.subcategory === "TRADE" ? [] : s.cards.slice(0, 2))));
  return (
    <div className="panel">
      <button className="holding" onClick={toggle} aria-expanded={open}>
        <Avatar symbol={a.asset?.symbol ?? "?"} />
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
