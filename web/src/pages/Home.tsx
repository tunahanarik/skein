import { useEffect, useState } from "react";
import { api, type AssetListItem } from "../api";
import { AlertList } from "../components/AlertForm";
import { Avatar, Skeleton, useAssetList, useAsync } from "../components/common";
import { useAggregator } from "../components/AggregatorSwap";
import { AssetPicker, idleSuggestions, IntentCards, OpportunityRows, usePortfolio, WalletSummary } from "../components/market";
import { usd } from "../format";
import { useI18n } from "../i18n";
import { intentsOf, topOpportunities } from "../intents";
import { linkProps, navigate } from "../router";
import { code } from "../text";
import { useWallet } from "../wallet";
import { useWatchlist } from "../watchlist";

const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;

export function WalletEntry({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const w = useWallet();
  const [text, setText] = useState("");
  return (
    <div className="panel pad connect-strip">
      <div className="txt">
        <h2>{compact ? t("walletEntry.titleView") : t("walletEntry.titleStart")}</h2>
        <p className="muted small">{t("walletEntry.hint")}</p>
      </div>
      <div className="act">
        <div className="row">
          <button className="btn primary round" disabled={w.connecting} onClick={w.openPicker}>
            {w.connecting ? t("walletEntry.waiting") : t("walletEntry.use")}
          </button>
          {w.address && w.source === "connected" && (
            <a className="btn round" {...linkProps("/wallet")}>
              {t("walletEntry.open")}
            </a>
          )}
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
        {w.error && <div className="small" style={{ color: "var(--bad)" }}>{t(w.error)}</div>}
        <div className="faint small">{t("walletEntry.footnote")}</div>
      </div>
    </div>
  );
}

export function HomePage() {
  const { t } = useI18n();
  const list = useAssetList();
  const watch = useWatchlist();
  const w = useWallet();
  const portfolio = usePortfolio(w.source === "connected" ? w.address : null);
  const agg = useAggregator();
  const [sel, setSel] = useState<AssetListItem | null>(null);
  // Default asset: the largest holding of a connected wallet, else NVDA.
  useEffect(() => {
    if (!list || sel) return;
    const held = portfolio ? idleSuggestions(portfolio)[0]?.asset.asset?.key : undefined;
    setSel(list.find((a) => a.key === held) ?? list.find((a) => a.symbol === "NVDA") ?? list[0] ?? null);
  }, [list, portfolio, sel]);
  const intel = useAsync((s) => (sel ? api.asset(sel.address, {}, s) : Promise.resolve(null)), [sel?.key]);
  const v = intel.data;
  const cov = useAsync((s) => api.coverage(s), []);
  const rows = cov.data?.rows ?? null;
  const count = (k: "canTrade" | "canEarn" | "canBorrowAgainst" | "canProvideLiquidity") => rows?.filter((r) => r.capabilities[k]).length ?? 0;
  const top = rows
    ? [...rows]
        .map((r) => ({ r, n: Object.values(r.capabilities.detail).filter((d) => d === "ACTIONABLE").length }))
        .sort((a, b) => b.n - a.n || b.r.actionable - a.r.actionable || a.r.asset.symbol.localeCompare(b.r.asset.symbol))
        .slice(0, 8)
    : [];
  const ways = v ? intentsOf(v).filter((i) => (i.key === "TRADE" ? i.count > 0 : i.usable.length > 0)).length : 0;
  const ref = sel?.symbol ?? "";

  return (
    <>
      <section className="hero">
        <h1 className="hold">
          <span>{t("home.hold1")}</span> <AssetPicker label={t("home.pickAsset")} value={sel} onChange={setSel} /> <span className="br">{t("home.hold2")}</span>
        </h1>
        <p>{v ? t("home.sub", { n: ways, m: v.summary.protocols.length }) : t("home.subLoading")}</p>
      </section>

      {v ? <IntentCards v={v} agg={sel ? (agg?.get(sel.key) ?? null) : null} hrefFor={(k) => `/asset/${encodeURIComponent(ref)}?i=${k}`} /> : <div className="intents">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="intent off"><Skeleton h={14} w="60%" /><Skeleton h={26} w="45%" /></div>)}</div>}

      <section className="section">
        <div className="section-head">
          <h2>{t("home.whereGo", { s: ref })}</h2>
          <span className="spacer" />
          {sel && (
            <a className="small" {...linkProps(`/asset/${encodeURIComponent(ref)}`)}>
              {t("home.allFor", { s: ref })}
            </a>
          )}
        </div>
        {v ? <OpportunityRows rows={topOpportunities(v, 6)} assetRef={ref} /> : <div className="panel pad" style={{ display: "grid", gap: 10 }}><Skeleton /><Skeleton /><Skeleton /></div>}
      </section>

      <section className="section">
        {portfolio ? (
          <>
            <div className="section-head">
              <h2>{t("wsum.title")}</h2>
            </div>
            <WalletSummary p={portfolio} />
          </>
        ) : (
          <WalletEntry />
        )}
      </section>

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
