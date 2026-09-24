import { useState } from "react";
import { api } from "../api";
import { AlertList } from "../components/AlertForm";
import { AssetSearch } from "../components/AssetSearch";
import { Avatar, Skeleton, useAssetList, useAsync } from "../components/common";
import { usd } from "../format";
import { useI18n } from "../i18n";
import { linkProps, navigate } from "../router";
import { code } from "../text";
import { useWallet } from "../wallet";
import { useWatchlist } from "../watchlist";

const QUICK = ["NVDA", "USDG", "WETH", "TSLA", "SGOV", "AAPL"];
const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;

export function WalletEntry({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const w = useWallet();
  const [text, setText] = useState("");
  return (
    <div className="panel pad" style={{ display: "grid", gap: 12 }}>
      <div>
        <h2>{compact ? t("walletEntry.titleView") : t("walletEntry.titleStart")}</h2>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          {t("walletEntry.hint")}
        </p>
      </div>
      <form
        className="row"
        style={{ flexWrap: "nowrap" }}
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
      <div className="row">
        <button className="btn primary" disabled={w.connecting || !w.hasInjected} onClick={() => void w.connect()}>
          {w.connecting ? t("walletEntry.waiting") : w.hasInjected ? t("walletEntry.use") : t("walletEntry.none")}
        </button>
        {w.address && w.source === "connected" && (
          <a className="btn" {...linkProps("/wallet")}>
            {t("walletEntry.open")}
          </a>
        )}
      </div>
      {w.error && <div className="small" style={{ color: "var(--bad)" }}>{t(w.error)}</div>}
      <div className="faint small">{t("walletEntry.footnote")}</div>
    </div>
  );
}

export function HomePage() {
  const { t } = useI18n();
  const list = useAssetList();
  const watch = useWatchlist();
  const cov = useAsync((s) => api.coverage(s), []);
  const rows = cov.data?.rows ?? null;
  const count = (k: "canTrade" | "canEarn" | "canBorrowAgainst" | "canProvideLiquidity") => rows?.filter((r) => r.capabilities[k]).length ?? 0;
  const top = rows
    ? [...rows]
        .map((r) => ({ r, n: Object.values(r.capabilities.detail).filter((d) => d === "ACTIONABLE").length }))
        .sort((a, b) => b.n - a.n || b.r.actionable - a.r.actionable || a.r.asset.symbol.localeCompare(b.r.asset.symbol))
        .slice(0, 6)
    : [];

  return (
    <>
      <section className="hero">
        <h1>{t("home.title")}</h1>
        <p>{t("home.lead")}</p>
      </section>

      <div className="entry-grid">
        <div className="panel pad" style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <div>
            <h2>{t("home.lookup")}</h2>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              {t("home.lookupHint")}
            </p>
          </div>
          <AssetSearch autoFocus />
          <div className="quick">
            {QUICK.map((s) => (
              <a key={s} {...linkProps(`/asset/${s}`)}>
                <Avatar symbol={s} address={list?.find((a) => a.symbol === s)?.address ?? null} />
                {s}
              </a>
            ))}
          </div>
        </div>
        <WalletEntry />
      </div>

      {watch.keys.length > 0 && (
        <section className="section">
          <div className="section-head">
            <h2>{t("watch.title")}</h2>
            <span className="muted">{t("watch.hint")}</span>
          </div>
          <div className="quick">
            {watch.keys.map((k) => {
              const r = rows?.find((x) => x.asset.key === k);
              const meta = list?.find((x) => x.key === k);
              const sym = r?.asset.symbol ?? meta?.symbol;
              if (!sym) return null;
              return (
                <a key={k} {...linkProps(`/asset/${meta?.address ?? sym}`)}>
                  <Avatar symbol={sym} address={meta?.address ?? null} />
                  {sym}
                  {r && (
                    <span className="row" style={{ gap: 3, marginLeft: 4 }}>
                      {CATS.map((c) => (
                        <span key={c} className={`dot ${r.capabilities.detail[c]}`} title={`${t(`cat.${c}`)}: ${t(`cap.${r.capabilities.detail[c]}`)}`} />
                      ))}
                    </span>
                  )}
                </a>
              );
            })}
          </div>
        </section>
      )}

      <AlertList />

      <section className="section">
        <div className="section-head">
          <h2>{t("home.across", { n: rows ? rows.length : "…" })}</h2>
          <a className="small" {...linkProps("/coverage")}>
            {t("home.fullCoverage")}
          </a>
        </div>
        <div className="grid four">
          {(["canTrade", "canEarn", "canBorrowAgainst", "canProvideLiquidity"] as const).map((k) => (
            <div key={k} className="panel stat">
              <div className="v num">{rows ? count(k) : <Skeleton h={30} w={50} />}</div>
              <div className="l">{t(`home.stat.${k}`)}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{t("home.most")}</h2>
          <span className="muted">{t("home.mostHint")}</span>
        </div>
        <div className="panel table-wrap">
          {!rows && !cov.error && (
            <div style={{ padding: 16, display: "grid", gap: 10 }}>
              <Skeleton />
              <Skeleton />
              <Skeleton />
            </div>
          )}
          {cov.error && (
            <div style={{ padding: 16 }} className="muted">
              {t("home.coverageDown")}
            </div>
          )}
          {top.length > 0 && (
            <table className="data">
              <tbody>
                {top.map(({ r }) => (
                  <tr key={r.asset.key} className="clickable" onClick={() => navigate(`/asset/${r.asset.symbol}`)}>
                    <td style={{ width: 44 }}>
                      <Avatar symbol={r.asset.symbol} address={r.asset.address} />
                    </td>
                    <td>
                      <a {...linkProps(`/asset/${r.asset.symbol}`)} style={{ fontWeight: 600, color: "var(--text)" }}>
                        {r.asset.symbol}
                      </a>
                      <div className="small muted">{code(t, "type", r.asset.registryType)}</div>
                    </td>
                    <td className="num">{usd(r.portfolioPriceUsd)}</td>
                    <td>
                      <div className="row" style={{ gap: 14 }}>
                        {CATS.map((c) => (
                          <span key={c} className="row small" style={{ gap: 5 }}>
                            <span className={`dot ${r.capabilities.detail[c]}`} />
                            {t(`cat.${c}`)}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="small muted" style={{ textAlign: "right" }}>
                      {r.protocols.join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}
