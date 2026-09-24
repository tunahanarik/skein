import { useMemo, useState } from "react";
import { api, type Coverage } from "../api";
import { Avatar, ErrorBox, Skeleton, useAsync } from "../components/common";
import { usd } from "../format";
import { useI18n } from "../i18n";
import { linkProps, navigate } from "../router";
import { code } from "../text";

const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;
const RANK: Record<string, number> = { ACTIONABLE: 0, LIMITED_ONLY: 1, INFORMATIONAL_ONLY: 2, NONE: 3 };
type SortKey = "symbol" | "options" | (typeof CATS)[number];

export function CoveragePage() {
  const { t } = useI18n();
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

  const legend = t("coverage.legend", { g: "\u0000g", a: "\u0000a", b: "\u0000b", n: "\u0000n" }).split(/\u0000([gabn])/);
  const DOT: Record<string, string> = { g: "ACTIONABLE", a: "LIMITED_ONLY", b: "INFORMATIONAL_ONLY", n: "NONE" };

  return (
    <>
      <h1>{t("coverage.title")}</h1>
      <p className="muted" style={{ maxWidth: 720 }}>
        {t("coverage.lead")}
      </p>
      <div className="row" style={{ margin: "16px 0" }}>
        <input className="input" style={{ maxWidth: 240 }} placeholder={t("coverage.filter")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("coverage.filter")} />
        <div className="tabs" role="group" aria-label={t("coverage.showCan")}>
          {(["ALL", ...CATS] as const).map((c) => (
            <button key={c} aria-pressed={filter === c} onClick={() => setFilter(c)}>
              {c === "ALL" ? t("coverage.all") : t(`cat.${c}`)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="small muted">{res.data ? t("coverage.of", { a: rows.length, b: res.data.rows.length }) : ""}</span>
      </div>
      {res.error && <ErrorBox error={res.error} onRetry={res.reload} />}
      <div className="panel table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th className="sortable" onClick={() => setSort("symbol")}>
                {t("coverage.asset")}
              </th>
              <th>{t("coverage.price")}</th>
              {CATS.map((c) => (
                <th key={c} className="sortable" onClick={() => setSort(c)} style={{ textAlign: "center" }}>
                  {t(`cat.${c}`)}
                </th>
              ))}
              <th className="sortable" onClick={() => setSort("options")} style={{ textAlign: "right" }}>
                {t("coverage.availLim")}
              </th>
              <th>{t("coverage.protocols")}</th>
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
              <tr key={r.asset.key} className="clickable" onClick={() => navigate(`/asset/${r.asset.address}`)}>
                <td>
                  <div className="row" style={{ gap: 10, flexWrap: "nowrap" }}>
                    <Avatar symbol={r.asset.symbol} />
                    <div>
                      <a {...linkProps(`/asset/${r.asset.address}`)} style={{ fontWeight: 600, color: "var(--text)" }}>
                        {r.asset.symbol}
                      </a>
                      <div className="small muted">{code(t, "type", r.asset.registryType)}</div>
                    </div>
                  </div>
                </td>
                <td className="num">{usd(r.portfolioPriceUsd)}</td>
                {CATS.map((c) => (
                  <td key={c} style={{ textAlign: "center" }} title={t(`cap.${r.capabilities.detail[c]}`)}>
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
        {legend.map((part, i) => (i % 2 === 1 ? <span key={i} className={`dot ${DOT[part]}`} /> : <span key={i}>{part}</span>))}
      </p>
    </>
  );
}
