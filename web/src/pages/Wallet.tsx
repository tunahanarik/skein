import { useState } from "react";
import { api, type Intelligence } from "../api";
import { CardView } from "../components/CardView";
import { Avatar, ErrorBox, LoadingCards, useAsync } from "../components/common";
import { amount, shortAddr, usd } from "../format";
import { linkProps } from "../router";
import { CATEGORY_TEXT, QUALITY_TEXT, TYPE_TEXT } from "../text";
import { useWallet } from "../wallet";
import { WalletEntry } from "./Home";

const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;

export function WalletPage() {
  const w = useWallet();
  if (!w.address) {
    return (
      <div style={{ maxWidth: 560 }}>
        <h1 style={{ marginBottom: 14 }}>Wallet</h1>
        <WalletEntry compact />
      </div>
    );
  }
  return <WalletView key={w.address} address={w.address} />;
}

function WalletView({ address }: { address: string }) {
  const w = useWallet();
  const res = useAsync((s) => api.portfolio(address, s), [address]);
  const p = res.data;
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div>
          <div className="muted small">{w.source === "connected" ? "Connected wallet (read-only)" : "Viewing address (read-only)"}</div>
          <h1 className="mono" style={{ fontSize: 24 }} title={address}>
            {shortAddr(address)}
          </h1>
        </div>
        <span className="spacer" />
        <button className="btn small" onClick={res.reload} disabled={res.loading}>
          Refresh
        </button>
        <button className="btn small ghost" onClick={w.clear}>
          Forget address
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
              <div className="l">Priced holdings{p.unpricedAssetCount ? ` (+${p.unpricedAssetCount} unpriced)` : ""}</div>
            </div>
            <div className="panel stat">
              <div className="v num">{usd(p.supportedAssetValueUsd)}</div>
              <div className="l">In assets with something to do</div>
            </div>
            <div className="panel stat">
              <div className="v num">{usd(p.unsupportedAssetValueUsd)}</div>
              <div className="l">In assets with no covered option</div>
            </div>
            <div className="panel stat">
              <div className="v num">{p.opportunityCounts.actionable + p.opportunityCounts.limited}</div>
              <div className="l">Available or limited opportunities</div>
            </div>
          </div>
          {p.dataQuality.status !== "COMPLETE" && (
            <p className="small" style={{ color: "var(--warn)" }}>
              {QUALITY_TEXT[p.dataQuality.status]}: {p.dataQuality.reasons.map((r) => r.detail ?? r.code).join("; ")}
            </p>
          )}

          <section className="section">
            <div className="section-head">
              <h2>Holdings</h2>
              <span className="muted">Balances are never quoted automatically. Open an asset to compare routes for an amount you choose.</span>
            </div>
            {p.assets.length === 0 && <div className="panel empty">No verified Robinhood Chain assets found in this wallet.</div>}
            <div style={{ display: "grid", gap: 10 }}>
              {p.assets.map((a) => (
                <Holding key={a.asset?.key} a={a} open={open === a.asset?.key} toggle={() => setOpen(open === a.asset?.key ? null : a.asset?.key ?? null)} />
              ))}
            </div>
            {p.unsupportedAssets.length > 0 && (
              <div className="panel pad" style={{ marginTop: 12 }}>
                <h3>Not covered</h3>
                <ul className="small muted" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                  {p.unsupportedAssets.map((u) => (
                    <li key={u.asset.key}>
                      {u.asset.symbol}: {u.reason}
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
  const d = a.summary.capabilities.detail;
  const cards = a.categories.flatMap((c) => c.subcategories.flatMap((s) => (s.subcategory === "TRADE" ? [] : s.cards.slice(0, 2))));
  return (
    <div className="panel">
      <button onClick={toggle} aria-expanded={open} style={{ all: "unset", display: "flex", gap: 12, alignItems: "center", padding: "14px 16px", cursor: "pointer", width: "100%", boxSizing: "border-box", flexWrap: "wrap" }}>
        <Avatar symbol={a.asset?.symbol ?? "?"} />
        <div style={{ minWidth: 120 }}>
          <div style={{ fontWeight: 650 }}>{a.asset?.symbol}</div>
          <div className="small muted">{TYPE_TEXT[a.asset?.registryType ?? ""] ?? ""}</div>
        </div>
        <div className="num" style={{ minWidth: 150 }}>
          <div>{amount(a.balance?.displayBalance)} tokens</div>
          {a.balance?.stock && <div className="small faint">≈ {amount(a.balance.stock.displayShareBalance)} shares</div>}
        </div>
        <div className="num" style={{ minWidth: 90 }}>{usd(a.balance?.valueUsd?.display ?? null)}</div>
        <span className="spacer" />
        <div className="row" style={{ gap: 12 }}>
          {CATS.map((c) => (
            <span key={c} className="row small" style={{ gap: 5 }} title={d[c]}>
              <span className={`dot ${d[c]}`} />
              {CATEGORY_TEXT[c]!.title}
            </span>
          ))}
        </div>
        <span className="faint">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div style={{ padding: "0 16px 16px", display: "grid", gap: 12 }}>
          {cards.length === 0 ? <div className="muted small">No lending, borrowing or liquidity option for this asset right now.</div> : <div className="grid two">{cards.map((c) => <CardView key={c.cardId} card={c} showRank={false} />)}</div>}
          <div>
            <a className="btn small" {...linkProps(`/asset/${a.asset?.symbol}`)}>
              All options for {a.asset?.symbol} →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
