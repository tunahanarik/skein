import { useEffect, useState } from "react";
import { amount, feePpm, fixed, usd } from "../format";
import { useI18n } from "../i18n";
import { usePairsFor, useLive } from "../live";
import { useAssetList, Avatar } from "./common";

/** ≥ 1: two decimals, always; below 1: six significant digits. */
function livePrice(v: string): string {
  const n = Number(v);
  return n >= 1 ? fixed(n, 2) : amount(v, 6);
}

/** Re-render every second while mounted (for "x s ago" and fading flashes). */
function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** Live spot prices of an asset's most liquid pools, pushed by the server as they change. */
export function LivePairs({ assetKey, symbol }: { assetKey: string; symbol: string }) {
  const { t } = useI18n();
  const live = useLive({ pairs: [assetKey] });
  const rows = usePairsFor(live, assetKey);
  const list = useAssetList();
  const [all, setAll] = useState(false);
  useTick();
  const addr = (key: string) => list?.find((a) => a.key === key)?.address ?? null;
  const shown = all ? rows : rows.slice(0, 5);
  const secs = live.lastAt ? Math.max(0, Math.round((Date.now() - live.lastAt) / 1000)) : null;

  return (
    <section className="live-pairs panel">
      <div className="lp-head">
        <h2>{t("live.title")}</h2>
        <span className={`live-dot${live.connected ? " on" : ""}`} aria-hidden="true" />
        <span className="muted small">
          {live.connected ? t("live.status", { s: Math.round(live.pollMs / 1000) }) : t("live.connecting")}
          {live.connected && live.block ? ` · ${t("live.block", { b: amount(live.block, 0) })}` : ""}
          {secs !== null && live.connected ? ` · ${t("live.ago", { n: secs })}` : ""}
        </span>
      </div>
      {!rows.length ? (
        <div className="muted small" style={{ padding: "8px 0" }}>
          {live.connected ? t("live.none") : t("misc.loading")}
        </div>
      ) : (
        <div className="lp-rows" role="table" aria-label={t("live.title")}>
          {shown.map((r) => {
            const fresh = r.move && Date.now() - r.move.at < 1500;
            return (
              <div key={r.tick.id} role="row" className="lp-row">
                <span className="pair" role="cell">
                  <span className="avs">
                    <Avatar symbol={symbol} address={addr(assetKey)} />
                    <Avatar symbol={r.other.symbol} address={addr(r.other.key)} />
                  </span>
                  <span>
                    <span className="s">
                      {symbol} / {r.other.symbol}
                    </span>
                    <span className="v">
                      {r.tick.venue} · {feePpm(r.tick.feePpm)}
                    </span>
                  </span>
                </span>
                <span role="cell" className={`px num${fresh ? (r.move!.dir > 0 ? " up" : " down") : ""}`}>
                  {r.price ? livePrice(r.price) : "·"} <small>{r.other.symbol}</small>
                  {r.move && <span className={`arrow ${r.move.dir > 0 ? "up" : "down"}`}>{r.move.dir > 0 ? "▲" : "▼"}</span>}
                </span>
                <span role="cell" className="tvl muted small num">
                  {r.tick.tvlUsd ? usd(r.tick.tvlUsd, { compact: true }) : "·"}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="lp-foot faint small">
        {rows.length > 5 && (
          <button className="linkish" onClick={() => setAll(!all)}>
            {all ? t("live.less") : t("live.more", { n: rows.length - 5 })}
          </button>
        )}
        <span>{t("live.note")}</span>
      </div>
    </section>
  );
}
