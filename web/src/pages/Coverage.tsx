import { useMemo, useState } from "react";
import { api, type Coverage } from "../api";
import { Avatar, ErrorBox, Skeleton, useAsync } from "../components/common";
import { usd } from "../format";
import { linkProps, navigate } from "../router";
import { TYPE_TEXT } from "../text";

const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;
const RANK: Record<string, number> = { ACTIONABLE: 0, LIMITED_ONLY: 1, INFORMATIONAL_ONLY: 2, NONE: 3 };
type SortKey = "symbol" | "options" | (typeof CATS)[number];

export function CoveragePage() {
  const res = useAsync((s) => api.coverage(s), []);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"ALL" | (typeof CATS)[number]>("ALL");
  const [sort, setSort] = useState<SortKey>("options");
  const rows = useMemo(() => {
    const all = res.data?.rows ?? [];
    const s = q.trim().toLowerCase();
    const opts = (r: Coverage) => CATS.filter((c) => r.capabilities.detail[c] === "ACTIONABLE").length;
    return all
      .filter((r) => !s || r.asset.symbol.toLowerCase().includes(s))
      .filter((r) => filter === "ALL" || r.capabilities.detail[filter] === "ACTIONABLE")
      .sort((a, b) =>
        sort === "symbol"
          ? a.asset.symbol.localeCompare(b.asset.symbol)
          : sort === "options"
            ? opts(b) - opts(a) || b.actionable - a.actionable || a.asset.symbol.localeCompare(b.asset.symbol)
            : RANK[a.capabilities.detail[sort]]! - RANK[b.capabilities.detail[sort]]! || a.asset.symbol.localeCompare(b.asset.symbol),
      );
  }, [res.data, q, filter, sort]);

  return (
    <>
      <h1>Coverage</h1>
      <p className="muted" style={{ maxWidth: 720 }}>
        What every verified Robinhood Chain asset can do today across the protocols we read (Uniswap v3, Morpho, Pendle). A green dot means at least one opportunity passes every
        check; amber means only limited ones exist (for example under $10k of liquidity).
      </p>
      <div className="row" style={{ margin: "16px 0" }}>
        <input className="input" style={{ maxWidth: 240 }} placeholder="Filter by symbol" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter by symbol" />
        <div className="tabs" role="group" aria-label="Show assets that can">
          {(["ALL", ...CATS] as const).map((c) => (
            <button key={c} aria-pressed={filter === c} onClick={() => setFilter(c)}>
              {c === "ALL" ? "All" : c[0] + c.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="small muted">{res.data ? `${rows.length} of ${res.data.rows.length}` : ""}</span>
      </div>
      {res.error && <ErrorBox error={res.error} onRetry={res.reload} />}
      <div className="panel table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th className="sortable" onClick={() => setSort("symbol")} aria-sort={sort === "symbol" ? "ascending" : "none"}>
                Asset
              </th>
              <th>Price</th>
              {CATS.map((c) => (
                <th key={c} className="sortable" onClick={() => setSort(c)} style={{ textAlign: "center" }}>
                  {c[0] + c.slice(1).toLowerCase()}
                </th>
              ))}
              <th className="sortable" onClick={() => setSort("options")} style={{ textAlign: "right" }}>
                Available / limited
              </th>
              <th>Protocols</th>
            </tr>
          </thead>
          <tbody>
            {!res.data &&
              !res.error &&
              Array.from({ length: 8 }, (_, i) => (
                <tr key={i}>
                  <td colSpan={8}>
                    <Skeleton />
                  </td>
                </tr>
              ))}
            {rows.map((r) => (
              <tr key={r.asset.key} style={{ cursor: "pointer" }} onClick={() => navigate(`/asset/${r.asset.address}`)}>
                <td>
                  <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                    <Avatar symbol={r.asset.symbol} />
                    <div>
                      <a {...linkProps(`/asset/${r.asset.address}`)} style={{ fontWeight: 600, color: "var(--text)" }}>
                        {r.asset.symbol}
                      </a>
                      <div className="small muted">{TYPE_TEXT[r.asset.registryType ?? ""] ?? r.asset.registryType}</div>
                    </div>
                  </div>
                </td>
                <td className="num">{usd(r.portfolioPriceUsd)}</td>
                {CATS.map((c) => (
                  <td key={c} style={{ textAlign: "center" }} title={r.capabilities.detail[c]}>
                    <span className={`dot ${r.capabilities.detail[c]}`} />
                  </td>
                ))}
                <td className="num" style={{ textAlign: "right" }}>
                  {r.actionable} / {r.limited}
                </td>
                <td className="small muted">{r.protocols.join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="faint small">
        Legend: <span className="dot ACTIONABLE" /> available · <span className="dot LIMITED_ONLY" /> limited only · <span className="dot INFORMATIONAL_ONLY" /> information only ·{" "}
        <span className="dot NONE" /> nothing. Counts are raw opportunities (each pool direction counts once).
      </p>
    </>
  );
}
