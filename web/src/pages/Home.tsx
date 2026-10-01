import { api } from "../api";
import { AlertList } from "../components/AlertForm";
import { Avatar, useAssetList, useAsync } from "../components/common";
import { CommandHero } from "../components/CommandHero";
import { usePortfolio, WalletSummary } from "../components/market";
import { useI18n } from "../i18n";
import { linkProps } from "../router";
import { useWallet } from "../wallet";
import { useWatchlist } from "../watchlist";

const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;

/** Home: the wallet-first hero, then what belongs to this viewer (wallet summary, watchlist, alerts). */
export function HomePage() {
  const { t } = useI18n();
  const list = useAssetList();
  const watch = useWatchlist();
  const w = useWallet();
  const portfolio = usePortfolio(w.source === "connected" ? w.address : null);
  const cov = useAsync((s) => api.coverage(s), []);
  const rows = cov.data?.rows ?? null;

  return (
    <div className="home-wide">
      <CommandHero protocols={rows ? new Set(rows.flatMap((r) => r.protocols)).size : null} />

      {portfolio && (
        <section className="section">
          <div className="section-head">
            <h2>{t("wsum.title")}</h2>
          </div>
          <WalletSummary p={portfolio} />
        </section>
      )}

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
    </div>
  );
}
