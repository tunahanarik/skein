import { useEffect, useState } from "react";
import { api, type Intelligence } from "../api";
import { Avatar, ErrorBox, Skeleton, useAssetList, useAsync } from "../components/common";
import { pctText, usd } from "../format";
import { useI18n } from "../i18n";
import { linkProps } from "../router";
import { actionLabel, code } from "../text";

const CATS = ["TRADE", "EARN", "BORROW", "LIQUIDITY"] as const;
const SUBS = ["LEND", "VAULT", "FIXED_YIELD", "COLLATERAL", "LP"] as const;

function readParams(): [string, string] {
  const q = new URLSearchParams(location.search);
  const clean = (v: string | null, d: string) => (v && /^[A-Za-z0-9.\-]{1,16}$|^0x[0-9a-fA-F]{40}$/.test(v) ? v : d);
  return [clean(q.get("a"), "NVDA"), clean(q.get("b"), "TSLA")];
}

/** Side by side: two assets, same facts. Not a ranking — each row states what exists. */
export function ComparePage() {
  const { t } = useI18n();
  const [[a, b], setPair] = useState(readParams);
  useEffect(() => {
    const q = new URLSearchParams({ a, b });
    history.replaceState(null, "", `/compare?${q.toString()}`);
  }, [a, b]);
  const ra = useAsync((s) => api.asset(a, {}, s), [a]);
  const rb = useAsync((s) => api.asset(b, {}, s), [b]);
  const list = useAssetList();
  const symbols = [...new Set((list ?? []).map((x) => x.symbol))].sort();

  const picker = (value: string, set: (v: string) => void, label: string) => (
    <label className="toggle">
      {label}
      <select className="input" value={value} onChange={(e) => set(e.target.value)}>
        {!symbols.includes(value) && <option value={value}>{value}</option>}
        {symbols.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </label>
  );

  const views = [ra.data, rb.data];
  const cell = (v: Intelligence | null, f: (v: Intelligence) => React.ReactNode) => <td>{v ? f(v) : <Skeleton />}</td>;
  const top = (v: Intelligence, sub: string) => v.categories.flatMap((c) => c.subcategories).find((s) => s.subcategory === sub)?.cards[0] ?? null;

  return (
    <>
      <h1>{t("compare.title")}</h1>
      <p className="muted">{t("compare.lead")}</p>
      <div className="row" style={{ margin: "14px 0" }}>
        {picker(a, (v) => setPair([v, b]), t("compare.a"))}
        {picker(b, (v) => setPair([a, v]), t("compare.b"))}
      </div>
      {ra.error && <ErrorBox error={ra.error} onRetry={ra.reload} />}
      {rb.error && <ErrorBox error={rb.error} onRetry={rb.reload} />}
      <div className="panel table-wrap">
        <table className="data compare">
          <thead>
            <tr>
              <th />
              {views.map((v, i) => (
                <th key={i}>
                  {v?.asset ? (
                    <a {...linkProps(`/asset/${v.asset.symbol}`)} className="row" style={{ gap: 8, color: "var(--text)" }}>
                      <Avatar symbol={v.asset.symbol} address={v.asset.address} />
                      <span style={{ fontSize: 15 }}>{v.asset.symbol}</span>
                    </a>
                  ) : (
                    (i ? b : a)
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{t("coverage.price")}</th>
              {views.map((v, i) => (
                <td key={i} className="num">
                  {v ? (v.price?.usd ? usd(v.price.usd) : t("asset.unpriced")) : <Skeleton />}
                </td>
              ))}
            </tr>
            {CATS.map((c) => (
              <tr key={c}>
                <th scope="row">{t(`cat.${c}`)}</th>
                {views.map((v, i) => (
                  <td key={i}>
                    {v ? (
                      <span className="row small" style={{ gap: 6 }}>
                        <span className={`dot ${v.summary.capabilities.detail[c]}`} />
                        {t(`cap.${v.summary.capabilities.detail[c]}`)}
                      </span>
                    ) : (
                      <Skeleton />
                    )}
                  </td>
                ))}
              </tr>
            ))}
            {SUBS.map((sub) => (
              <tr key={sub}>
                <th scope="row">{code(t, "sub", sub)}</th>
                {views.map((v, i) =>
                  cell(v, (x) => {
                    const c = top(x, sub);
                    if (!c) return <span className="faint">·</span>;
                    return (
                      <div>
                        <div className="num" style={{ fontWeight: 600 }}>
                          {c.headline ? pctText(c.headline.display) : "·"} <span className="badge-inline">{code(t, "use", c.usability.status)}</span>
                        </div>
                        <div className="small muted">{actionLabel(t, c)}</div>
                      </div>
                    );
                  }),
                )}
              </tr>
            ))}
            <tr>
              <th scope="row">{t("compare.routes")}</th>
              {views.map((v, i) => cell(v, (x) => <span className="num">{x.tradeTargets.length}</span>))}
            </tr>
            <tr>
              <th scope="row">{t("coverage.protocols")}</th>
              {views.map((v, i) => cell(v, (x) => <span className="small">{x.summary.protocols.join(", ") || "·"}</span>))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="faint small">{t("compare.note")}</p>
    </>
  );
}
