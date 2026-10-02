import { api } from "../api";
import { AlertList } from "../components/AlertForm";
import { Avatar, useAssetList, useAsync } from "../components/common";
import { Braid } from "../components/Braid";
import { StatusLine, WalletResearch } from "../components/CommandHero";
import { Icon, ProtocolLogo } from "../components/icons";
import { usePortfolio, WalletSummary } from "../components/market";
import { useI18n } from "../i18n";
import { linkProps } from "../router";
import { useWallet } from "../wallet";
import { useWatchlist } from "../watchlist";

const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;

const STEPS = [
  { n: "01", title: "home.how.s1t", text: "home.how.s1d" },
  { n: "02", title: "home.how.s2t", text: "home.how.s2d" },
  { n: "03", title: "home.how.s3t", text: "home.how.s3d" },
] as const;
const PROTOCOLS = ["Morpho", "Pendle", "Beefy", "Uniswap", "Ramses", "Spark", "Steer"];

/** Home: information and wallet search only; the command terminal has its own page. */
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
      <section className="cmd-hero home-hero">
        <div className="hero-art" aria-hidden="true">
          <Braid />
        </div>
        <StatusLine protocols={rows ? new Set(rows.flatMap((r) => r.protocols)).size : null} />
        <WalletResearch />
      </section>

      {portfolio && (
        <section className="section">
          <div className="section-head">
            <h2>{t("wsum.title")}</h2>
          </div>
          <WalletSummary p={portfolio} />
        </section>
      )}

      <section className="section how">
        <div className="section-head">
          <h2>{t("home.how.title")}</h2>
        </div>
        <div className="how-steps">
          {STEPS.map((x) => (
            <div key={x.n} className="how-step">
              <span className="n">{x.n}</span>
              <b>{t(x.title)}</b>
              <span>{t(x.text)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>{t("home.proto.title")}</h2>
          <span className="spacer" />
          <a className="small" {...linkProps("/terminal")}>
            <Icon name="terminal" size={14} /> {t("home.proto.terminal")}
          </a>
        </div>
        <div className="proto-strip">
          {PROTOCOLS.map((p) => (
            <span key={p} className="proto">
              <ProtocolLogo name={p} size={22} />
              {p}
            </span>
          ))}
        </div>
        <p className="cmd-note">{t("home.proto.note")}</p>
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
    </div>
  );
}
