import { useEffect, useState } from "react";
import { api, type AssetListItem, type Intelligence } from "../api";
import { AlertList } from "../components/AlertForm";
import { Avatar, Skeleton, useAssetList, useAsync } from "../components/common";
import { useAggregator } from "../components/AggregatorSwap";
import { AssetPicker, idleSuggestions, INTENT_LOOK, IntentCards, oppValue, usePortfolio, useTodayChange, WalletSummary } from "../components/market";
import { ProtocolMark } from "../components/icons";
import { PriceChart } from "../components/PriceChart";
import { pct, usd } from "../format";
import { useI18n } from "../i18n";
import { topOpportunities } from "../intents";
import { useLive } from "../live";
import { actionLabel } from "../text";
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

/** The three best things to do with the asset, as large cards. */
function TopCards({ v, assetRef }: { v: Intelligence; assetRef: string }) {
  const { t } = useI18n();
  const rows = topOpportunities(v, 3);
  if (!rows.length) return <div className="panel empty small">{t("home.noOpps")}</div>;
  return (
    <div className="top-cards">
      {rows.map(({ intent, card }, i) => {
        const { val, unit } = oppValue(t, intent, card);
        const href = `/asset/${encodeURIComponent(assetRef)}?i=${intent}`;
        return (
          <a key={card.cardId} className="top-card" {...linkProps(href)}>
            <ProtocolMark name={card.protocol.name} icon={INTENT_LOOK[intent].icon} tone={INTENT_LOOK[intent].tone} size={36} />
            <span className="k">{actionLabel(t, card)}</span>
            <span className="p">{card.protocol.name}</span>
            <span className="v num">{val}</span>
            <span className="u">{unit}</span>
            <span className={`btn small${i === 0 ? " primary" : ""}`}>{t("home.inspect")}</span>
          </a>
        );
      })}
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
  const ref = sel?.symbol ?? "";

  return (
    <div className="home-col">
      <AssetStage sel={sel} onPick={setSel} v={v ?? null} />

      <section className="section">
        <div className="section-head">
          <h2>{t("home.canDoWith", { s: ref })}</h2>
          <span className="spacer" />
          {sel && (
            <a className="small" {...linkProps(`/asset/${encodeURIComponent(ref)}`)}>
              {t("home.allFor", { s: ref })}
            </a>
          )}
        </div>
        {v ? <TopCards v={v} assetRef={ref} /> : <div className="top-cards">{[0, 1, 2].map((i) => <div key={i} className="top-card"><Skeleton h={36} w={36} /><Skeleton h={14} w="70%" /><Skeleton h={28} w="50%" /></div>)}</div>}
        {v && (
          <div className="mini-intents">
            <IntentCards v={v} agg={sel ? (agg?.get(sel.key) ?? null) : null} hrefFor={(k) => `/asset/${encodeURIComponent(ref)}?i=${k}`} />
          </div>
        )}
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
    </div>
  );
}
