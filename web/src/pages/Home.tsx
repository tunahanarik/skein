import { useEffect, useState } from "react";
import { api, type AssetListItem, type Intelligence } from "../api";
import { AlertList } from "../components/AlertForm";
import { Avatar, Skeleton, useAssetList, useAsync } from "../components/common";
import { useAggregator } from "../components/AggregatorSwap";
import { AssetPicker, idleSuggestions, IntentCards, OpportunityRows, usePortfolio, useTodayChange, WalletSummary } from "../components/market";
import { PriceChart } from "../components/PriceChart";
import { CommandHero } from "../components/CommandHero";
import { pct, usd } from "../format";
import { useI18n } from "../i18n";
import { topOpportunities } from "../intents";
import { useLive } from "../live";
import { linkProps, navigate } from "../router";
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

const shortName = (n: string) => n.replace(/\s*•\s*Robinhood Token$/i, "");

/** The chosen asset: picker, live price and today's change, then its price chart. */
function AssetStage({ sel, onPick, v }: { sel: AssetListItem | null; onPick: (a: AssetListItem) => void; v: Intelligence | null }) {
  const { t } = useI18n();
  const live = useLive({ prices: sel ? [sel.key] : [] });
  const lp = sel ? live.prices.get(sel.key) : undefined;
  const today = useTodayChange(sel?.key ?? null);
  const price = lp?.usd ?? v?.price?.usd ?? null;
  return (
    <section className="stage">
      <div className="stage-top">
        <Avatar symbol={sel?.symbol ?? "?"} address={sel?.address ?? null} size="lg" />
        <div className="stage-id">
          <span className="n">{sel ? shortName(sel.name) : "…"}</span>
          <AssetPicker label={t("home.pickAsset")} value={sel} onChange={onPick} />
        </div>
        <span className="spacer" />
        <div className="stage-px">
          <span className="price num">{price ? usd(price) : <Skeleton h={30} w={120} />}</span>
          {today !== null && (
            <span className={`num ${today >= 0 ? "up" : "down"}`}>
              {today >= 0 ? "+" : ""}
              {pct(today, 2)} {t("asset.today")}
            </span>
          )}
        </div>
      </div>
      {sel && <PriceChart key={sel.key} assetRef={sel.address} />}
    </section>
  );
}

/** Stock tokens that moved most today; picking one shows it in the stage above. */
function TokenGrid({ list, onPick }: { list: AssetListItem[] | null; onPick: (a: AssetListItem) => void }) {
  const { t } = useI18n();
  const res = useAsync((sig) => api.markets(sig), []);
  const [kind, setKind] = useState<"all" | "stocks" | "crypto">("all");
  const rows = (Array.isArray(res.data?.rows) ? res.data!.rows : [])
    // Stablecoins barely move; they stay on the Markets page.
    .filter((r) => r.changePct !== null && r.type !== "STABLECOIN" && (kind === "all" || (kind === "stocks") === (r.type === "STOCK_TOKEN")))
    .sort((a, b) => Math.abs(b.changePct!) - Math.abs(a.changePct!))
    .slice(0, 24);
  if (!res.data) return null;
  return (
    <section className="section">
      <div className="section-head">
        <h2>{t("home.movers")}</h2>
        <div className="seg mini-seg" role="radiogroup" aria-label={t("markets.type")}>
          {(["all", "stocks", "crypto"] as const).map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? "on" : undefined} onClick={() => setKind(k)}>
              {t(`markets.${k}`)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <a className="small" {...linkProps("/markets")}>
          {t("home.seeAll")}
        </a>
      </div>
      {!rows.length && <div className="panel empty small">{t("markets.empty")}</div>}
      <div className="tok-grid">
        {rows.map((r) => (
          <button
            key={r.key}
            className="tok-cell"
            onClick={() => {
              const a = list?.find((x) => x.key === r.key);
              if (a) {
                onPick(a);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }
            }}
          >
            <Avatar symbol={r.symbol} address={r.address} />
            <span className="s">{r.symbol}</span>
            <span className={`num ch ${r.changePct! >= 0 ? "up" : "down"}`}>
              {r.changePct! >= 0 ? "+" : ""}
              {pct(r.changePct!, 1)}
            </span>
          </button>
        ))}
      </div>
    </section>
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
  const ref = sel?.symbol ?? "";

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

      <div className="home-grid section" id="asset-stage">
        <div className="panel stage-panel">
          <AssetStage sel={sel} onPick={setSel} v={v ?? null} />
        </div>
        <div className="panel can-panel">
          <div className="section-head">
            <h2>{t("home.canDoWith", { s: ref })}</h2>
            <span className="spacer" />
            {sel && (
              <a className="small" {...linkProps(`/asset/${encodeURIComponent(ref)}`)}>
                {t("home.allFor", { s: ref })}
              </a>
            )}
          </div>
          {v ? <OpportunityRows rows={topOpportunities(v, 6)} assetRef={ref} /> : <div style={{ display: "grid", gap: 14 }}><Skeleton h={40} /><Skeleton h={40} /><Skeleton h={40} /></div>}
        </div>
      </div>
      {v && (
        <div className="mini-intents">
          <IntentCards v={v} agg={sel ? (agg?.get(sel.key) ?? null) : null} hrefFor={(k) => `/asset/${encodeURIComponent(ref)}?i=${k}`} />
        </div>
      )}

      <TokenGrid list={list} onPick={setSel} />

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
