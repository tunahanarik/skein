import { useState, type FormEvent } from "react";
import { Avatar } from "../components/common";
import { Icon } from "../components/icons";
import { idleSuggestions, usePortfolio } from "../components/market";
import { shortAddr, usd } from "../format";
import { useI18n } from "../i18n";
import { navigate } from "../router";
import { MAX_TRACKED, useTracked, type TrackedWallet } from "../tracked";
import { useWallet } from "../wallet";

/** One tracked wallet: value, holdings and idle value, read like a pasted address. */
function TrackedCard({ x, onRemove }: { x: TrackedWallet; onRemove: () => void }) {
  const { t } = useI18n();
  const w = useWallet();
  const p = usePortfolio(x.address);
  const held = p ? p.assets.filter((a) => Number(a.balance?.valueUsd?.display ?? 0) > 0 || (a.balance?.rawBalance && a.balance.rawBalance !== "0")) : [];
  const total = held.reduce((s, a) => s + (Number(a.balance?.valueUsd?.display ?? 0) || 0), 0);
  const idle = p ? idleSuggestions(p).filter((s) => s.best !== null) : [];
  const idleUsd = idle.reduce((s, a) => s + a.valueUsd, 0);
  const top = [...held].sort((a, b) => Number(b.balance?.valueUsd?.display ?? 0) - Number(a.balance?.valueUsd?.display ?? 0)).slice(0, 5);
  const open = () => {
    if (w.usePasted(x.address)) navigate("/wallet");
  };
  return (
    <article className="tw-card">
      <div className="tw-top">
        <span className="tw-ic">
          <Icon name="wallet" size={16} />
        </span>
        <div className="tw-id">
          <span className="tw-label">{x.label || shortAddr(x.address)}</span>
          <span className="tw-addr" title={x.address}>
            {shortAddr(x.address)}
          </span>
        </div>
        <span className="spacer" />
        <button className="tw-x" onClick={onRemove} aria-label={t("tracked.remove")} title={t("tracked.remove")}>
          ✕
        </button>
      </div>
      {!p ? (
        <div className="tw-load">{t("tracked.reading")}</div>
      ) : (
        <>
          <div className="tw-stats">
            <div>
              <span className="k">{t("tracked.value")}</span>
              <span className="v num" title={usd(String(total))}>{usd(String(total), { compact: true })}</span>
            </div>
            <div>
              <span className="k">{t("tracked.assets")}</span>
              <span className="v num">{held.length}</span>
            </div>
            <div>
              <span className="k">{t("tracked.idle")}</span>
              <span className={`v num${idleUsd > 0 ? " warn" : ""}`} title={usd(String(idleUsd))}>{usd(String(idleUsd), { compact: true })}</span>
            </div>
          </div>
          <div className="tw-top-assets">
            {top.map((a) => (a.asset ? <Avatar key={a.asset.key} symbol={a.asset.symbol} address={a.asset.address} /> : null))}
            {held.length > top.length && <span className="more">+{held.length - top.length}</span>}
            {!held.length && <span className="faint small">{t("tracked.empty")}</span>}
          </div>
        </>
      )}
      <button className="btn small tw-open" onClick={open}>
        {t("tracked.open")} →
      </button>
    </article>
  );
}

/** Wallets the user follows, stored in this browser only. */
export function TrackedPage() {
  const { t } = useI18n();
  const tr = useTracked();
  const [addr, setAddr] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const a = addr.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return setErr(t("home.w.bad"));
    if (!tr.add(a, label)) return setErr(t("tracked.full", { n: MAX_TRACKED }));
    setAddr("");
    setLabel("");
    setErr(null);
  };
  return (
    <div className="tracked">
      <div className="tw-head">
        <div>
          <div className="hero-step">{t("tracked.step")}</div>
          <h1>{t("tracked.title")}</h1>
          <p className="muted">{t("tracked.lead")}</p>
        </div>
        <span className="tw-count num">
          {tr.list.length}/{MAX_TRACKED}
        </span>
      </div>

      <form className={`tw-form${err ? " err" : ""}`} onSubmit={submit}>
        <Icon name="wallet" size={18} />
        <input className="tw-in-addr" value={addr} spellCheck={false} autoComplete="off" aria-label={t("walletEntry.label")} placeholder={t("home.w.placeholder")} onChange={(e) => (setAddr(e.target.value.trim().slice(0, 64)), setErr(null))} />
        <input className="tw-in-label" value={label} autoComplete="off" aria-label={t("tracked.label")} placeholder={t("tracked.labelPh")} onChange={(e) => setLabel(e.target.value.slice(0, 24))} />
        <button className="btn primary" type="submit" disabled={!addr}>
          + {t("tracked.track")}
        </button>
      </form>
      {err && <div className="cmd-err">{err}</div>}
      <div className="cmd-note">{t("tracked.note")}</div>

      {tr.list.length ? (
        <div className="tw-grid">
          {tr.list.map((x) => (
            <TrackedCard key={x.address} x={x} onRemove={() => tr.remove(x.address)} />
          ))}
        </div>
      ) : (
        <div className="tw-none">
          <Icon name="eye" size={22} />
          <b>{t("tracked.noneTitle")}</b>
          <span>{t("tracked.noneText")}</span>
        </div>
      )}
    </div>
  );
}
