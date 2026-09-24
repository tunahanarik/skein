import { useState } from "react";
import { api } from "../api";
import { AssetSearch } from "../components/AssetSearch";
import { Avatar, Skeleton, useAsync } from "../components/common";
import { usd } from "../format";
import { linkProps, navigate } from "../router";
import { TYPE_TEXT } from "../text";
import { useWallet } from "../wallet";

const QUICK = ["NVDA", "USDG", "WETH", "TSLA", "SGOV", "AAPL"];

export function WalletEntry({ compact }: { compact?: boolean }) {
  const w = useWallet();
  const [text, setText] = useState("");
  return (
    <div className="panel pad" style={{ display: "grid", gap: 12 }}>
      <div>
        <h2>{compact ? "View a wallet" : "Start from a wallet"}</h2>
        <p className="muted small" style={{ margin: "4px 0 0" }}>
          See every asset a wallet holds and what each can do. Only the public address is read; it is kept in this tab's memory and never stored.
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
          Wallet address
        </label>
        <input id="addr" className="input mono" placeholder="0x… public address" spellCheck={false} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="btn" type="submit">
          View
        </button>
      </form>
      <div className="row">
        <button
          className="btn primary"
          disabled={w.connecting || !w.hasInjected}
          onClick={async () => {
            await w.connect();
          }}
        >
          {w.connecting ? "Waiting for wallet…" : w.hasInjected ? "Use my browser wallet" : "No browser wallet detected"}
        </button>
        {w.address && w.source === "connected" && (
          <a className="btn" {...linkProps("/wallet")}>
            Open wallet view
          </a>
        )}
      </div>
      {w.error && <div className="small" style={{ color: "var(--bad)" }}>{w.error}</div>}
      <div className="faint small">Connecting only shares your address. This app never asks for a signature, an approval or a transaction.</div>
    </div>
  );
}

export function HomePage() {
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
        <h1>What can your Robinhood Chain assets do?</h1>
        <p>Pick a Stock Token, USDG or ETH and see where it can be traded, lent, used as collateral or put into a pool — with the source, age and limits of every number.</p>
      </section>

      <div className="entry-grid">
        <div className="panel pad" style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <div>
            <h2>Look up an asset</h2>
            <p className="muted small" style={{ margin: "4px 0 0" }}>
              Verified Robinhood Chain assets only. Look-alike tokens are never matched by name.
            </p>
          </div>
          <AssetSearch autoFocus />
          <div className="quick">
            {QUICK.map((s) => (
              <a key={s} {...linkProps(`/asset/${s}`)}>
                <Avatar symbol={s} />
                {s}
              </a>
            ))}
          </div>
        </div>
        <WalletEntry />
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Across all {rows ? rows.length : "…"} verified assets</h2>
          <a className="small" {...linkProps("/coverage")}>
            Full coverage →
          </a>
        </div>
        <div className="grid four">
          {(
            [
              ["canTrade", "can be traded"],
              ["canEarn", "can earn yield"],
              ["canBorrowAgainst", "can be borrowed against"],
              ["canProvideLiquidity", "can provide liquidity"],
            ] as const
          ).map(([k, l]) => (
            <div key={k} className="panel stat">
              <div className="v num">{rows ? count(k) : <Skeleton h={30} w={50} />}</div>
              <div className="l">assets {l} right now</div>
            </div>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Most options today</h2>
          <span className="muted">by number of intents with an available opportunity</span>
        </div>
        <div className="panel">
          {!rows && (
            <div style={{ padding: 16, display: "grid", gap: 10 }}>
              <Skeleton />
              <Skeleton />
              <Skeleton />
            </div>
          )}
          {cov.error && <div style={{ padding: 16 }} className="muted">Coverage is unavailable right now.</div>}
          {top.length > 0 && (
            <table className="data">
              <tbody>
                {top.map(({ r }) => (
                  <tr key={r.asset.key} style={{ cursor: "pointer" }} onClick={() => navigate(`/asset/${r.asset.symbol}`)}>
                    <td style={{ width: 44 }}>
                      <Avatar symbol={r.asset.symbol} />
                    </td>
                    <td>
                      <a {...linkProps(`/asset/${r.asset.symbol}`)} onClick={(e) => e.preventDefault()} style={{ fontWeight: 600, color: "var(--text)" }}>
                        {r.asset.symbol}
                      </a>
                      <div className="small muted">{TYPE_TEXT[r.asset.registryType ?? ""] ?? r.asset.registryType}</div>
                    </td>
                    <td className="num">{usd(r.portfolioPriceUsd)}</td>
                    <td>
                      <div className="row" style={{ gap: 14 }}>
                        {(["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const).map((c) => (
                          <span key={c} className="row small" style={{ gap: 5 }}>
                            <span className={`dot ${r.capabilities.detail[c]}`} />
                            {c[0] + c.slice(1).toLowerCase()}
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
