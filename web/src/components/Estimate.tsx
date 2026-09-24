import { useState } from "react";
import type { Card } from "../api";
import { amount, date } from "../format";
import { useI18n } from "../i18n";

/**
 * Simple what-if estimate from the card's headline rate. Display math only (floating point, rounded):
 *   variable rate (LEND, VAULT, LP):   amount × APY per year
 *   fixed rate to maturity (PT):       amount × ((1 + APY)^(days/365) − 1), in the rate's unit
 *   borrowing (COLLATERAL):            borrowed × borrow APY per year (cost)
 * Never a promise: rates move, PT is realised only if held to maturity, fees and slippage apply.
 */
export function Estimate({ card }: { card: Card }) {
  const { t } = useI18n();
  const h = card.headline;
  const [value, setValue] = useState("1000");
  if (!h || card.trade || card.subcategory === "YIELD") return null;
  const apy = Number(h.value) / 1e18;
  const x = Number(value);
  const valid = /^\d+(\.\d+)?$/.test(value) && x > 0 && value.length <= 20;
  const days = card.fixedYield?.secondsToMaturity ? card.fixedYield.secondsToMaturity / 86_400 : null;
  const unitNote = card.usability.notes.includes("ACCOUNTING_UNIT_NOT_TOKEN");
  const sym = card.subcategory === "COLLATERAL" ? (card.counterAsset?.symbol ?? "") : card.asset.symbol;

  let lines: string[] = [];
  if (valid) {
    if (card.subcategory === "FIXED_YIELD" && days !== null) {
      const gain = x * (Math.pow(1 + apy, days / 365) - 1);
      lines = [t("est.atMaturity", { x: amount(String(x + gain), 4), s: sym, g: amount(String(gain), 4), d: date(card.maturity) })];
    } else if (card.subcategory === "COLLATERAL") {
      lines = [t("est.borrowCost", { x: amount(String(x * apy), 4), s: sym })];
    } else {
      lines = [t("est.perYear", { x: amount(String(x * apy), 4), s: sym }), t("est.perMonth", { x: amount(String((x * apy) / 12), 4), s: sym })];
    }
  }

  return (
    <details className="more">
      <summary>{card.subcategory === "COLLATERAL" ? t("est.titleBorrow") : t("est.title")}</summary>
      <div className="body">
        <label className="toggle" style={{ gap: 10 }}>
          {card.subcategory === "COLLATERAL" ? t("est.borrowAmount", { s: sym }) : t("est.amount", { s: sym })}
          <input className="input num" style={{ width: 140 }} inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} aria-invalid={!valid} />
        </label>
        {!valid && <div className="small" style={{ color: "var(--bad)" }}>{t("est.invalid")}</div>}
        {lines.map((l) => (
          <div key={l} className="num" style={{ fontWeight: 600 }}>
            {l}
          </div>
        ))}
        <div className="faint small">
          {card.subcategory === "FIXED_YIELD" ? t("est.noteFixed") : card.subcategory === "COLLATERAL" ? t("est.noteBorrow") : t("est.noteVariable")}
          {unitNote ? ` ${t("est.noteUnit")}` : ""}
        </div>
      </div>
    </details>
  );
}
