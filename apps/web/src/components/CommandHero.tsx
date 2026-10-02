import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, type AssetListItem } from "../api";
import { topOpportunities, type IntentKey } from "../intents";
import { contextLine } from "../text";
import { useI18n } from "../i18n";
import { useLive } from "../live";
import { linkProps, navigate } from "../router";
import { useWallet } from "../wallet";
import { Avatar, useAssetList, useAsync } from "./common";
import { Icon, ProtocolLogo, type IconName } from "./icons";
import { AssetPicker, oppValue, useTodayChange } from "./market";
import { PriceChart } from "./PriceChart";
import { pct, usd } from "../format";

/** What a line typed into the command bar means. Wallet addresses come first: Skein is a wallet explorer. */
export type Command =
  | { kind: "wallet"; address: string }
  | { kind: "intent"; intent: "EARN" | "FIXED" | "BORROW" | "LIQUIDITY"; asset: AssetListItem }
  | { kind: "asset"; asset: AssetListItem }
  | { kind: "none" };

const VERBS: Record<string, "EARN" | "FIXED" | "BORROW" | "LIQUIDITY"> = {
  earn: "EARN", kazan: "EARN", yield: "EARN", getiri: "EARN",
  fixed: "FIXED", sabit: "FIXED",
  borrow: "BORROW", "borç": "BORROW", borc: "BORROW",
  lp: "LIQUIDITY", liquidity: "LIQUIDITY", likidite: "LIQUIDITY",
};
/** Filler words skipped when looking for the asset ("borrow against SPY", "earn yield on NVDA"). */
const FILLER = new Set(["on", "with", "against", "for", "to", "ile", "için", "yield", "a", "the", "from"]);

export function findAsset(list: readonly AssetListItem[], word: string): AssetListItem | null {
  const w = word.toLowerCase();
  if (!w) return null;
  return list.find((a) => a.symbol.toLowerCase() === w) ?? list.find((a) => a.address.toLowerCase() === w) ?? list.find((a) => a.name.toLowerCase().replace(/\s*•\s*robinhood token$/i, "") === w) ?? null;
}

export function parseCommand(line: string, list: readonly AssetListItem[]): Command {
  const s = line.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) {
    // A contract of a listed asset opens that asset; any other address is a wallet to explore.
    const a = list.find((x) => x.address.toLowerCase() === s.toLowerCase());
    return a ? { kind: "asset", asset: a } : { kind: "wallet", address: s };
  }
  const words = s.replace(/^>\s*/, "").split(/\s+/).filter(Boolean);
  if (!words.length) return { kind: "none" };
  const verb = VERBS[words[0]!.toLowerCase()];
  const rest = words.slice(1).filter((x) => !FILLER.has(x.toLowerCase()) && !/^\d+([.,]\d+)?$/.test(x));
  const asset = rest.map((x) => findAsset(list, x)).find((a) => !!a) ?? null;
  if (verb && asset) return { kind: "intent", intent: verb, asset };
  const only = findAsset(list, words.join(" ")) ?? findAsset(list, words[0]!);
  return only ? { kind: "asset", asset: only } : { kind: "none" };
}

/** Command templates: the verb only; the user chooses the asset. */
const EXAMPLES: { text: string; verb: string }[] = [
  { text: "earn yield on", verb: "earn" },
  { text: "fixed rate on", verb: "fixed" },
  { text: "borrow against", verb: "borrow" },
  { text: "provide liquidity", verb: "lp" },
];

const WHY: { icon: IconName; title: "home.w.b1t" | "home.w.b2t" | "home.w.b3t" | "home.w.b4t"; text: "home.w.b1d" | "home.w.b2d" | "home.w.b3d" | "home.w.b4d" }[] = [
  { icon: "earn", title: "home.w.b1t", text: "home.w.b1d" },
  { icon: "bank", title: "home.w.b2t", text: "home.w.b2d" },
  { icon: "chart", title: "home.w.b3t", text: "home.w.b3d" },
  { icon: "shield", title: "home.w.b4t", text: "home.w.b4d" },
];

/** Left: why and how to explore a wallet (the main use). */
export function WalletResearch() {
  const { t } = useI18n();
  const w = useWallet();
  const [addr, setAddr] = useState("");
  const [err, setErr] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (w.usePasted(addr.trim())) navigate("/wallet");
    else setErr(true);
  };
  return (
    <div className="hero-card hw">
      <div className="hero-step">{t("home.w.step")}</div>
      <h1 className="hw-title">{t("home.w.title")}</h1>
      <p className="hw-lead">{t("home.w.lead")}</p>
      <ul className="hw-why">
        {WHY.map((x) => (
          <li key={x.title}>
            <span className="ic">
              <Icon name={x.icon} size={16} />
            </span>
            <span>
              <b>{t(x.title)}</b>
              <span>{t(x.text)}</span>
            </span>
          </li>
        ))}
      </ul>
      <form className={`hw-form${err ? " err" : ""}`} onSubmit={submit}>
        <Icon name="wallet" size={18} />
        <input value={addr} spellCheck={false} autoComplete="off" aria-label={t("walletEntry.label")} placeholder={t("home.w.placeholder")} onChange={(e) => (setAddr(e.target.value.trim().slice(0, 64)), setErr(false))} />
        <button className="btn primary" type="submit" disabled={!addr}>
          {t("home.cmd.analyze")} ↵
        </button>
      </form>
      {err && <div className="cmd-err">{t("home.w.bad")}</div>}
      <div className="cmd-note">{t("home.w.note")}</div>
    </div>
  );
}

/** Right: the command terminal; results update live for the asset the user names or picks. */
export function CommandTerminal() {
  const { t } = useI18n();
  const list = useAssetList();
  const w = useWallet();
  const [line, setLine] = useState("");
  const [picked, setPicked] = useState<AssetListItem | null>(null);
  const [err, setErr] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const words = line.trim().split(/\s+/).filter(Boolean);
  const verb = words[0] ? VERBS[words[0].toLowerCase()] : undefined;
  const typed = list ? words.slice(verb ? 1 : 0).filter((x) => !FILLER.has(x.toLowerCase())).map((x) => findAsset(list, x)).find((x) => !!x) ?? null : null;
  const asset = typed ?? picked;
  const intent: IntentKey | null = verb ?? null;

  const last = line.endsWith(" ") ? "" : (words.at(-1) ?? "");
  const hits = useMemo(() => {
    const q = last.toLowerCase();
    if (!list || !q || q.startsWith("0x") || VERBS[q] || FILLER.has(q) || typed?.symbol.toLowerCase() === q) return [];
    const rank = (a: AssetListItem) => (a.symbol.toLowerCase() === q ? 0 : a.symbol.toLowerCase().startsWith(q) ? 1 : a.name.toLowerCase().startsWith(q) ? 2 : 9);
    return list.filter((a) => rank(a) < 9).sort((a, b) => rank(a) - rank(b) || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol)).slice(0, 6);
  }, [list, last, typed]);

  const intel = useAsync((sig) => (asset ? api.asset(asset.address, {}, sig) : Promise.resolve(null)), [asset?.key]);
  // "earn yield" means any yield: lending and vaults, fixed rates and liquidity provision.
  const matches = (k: IntentKey) => !intent || k === intent || (intent === "EARN" && (k === "FIXED" || k === "LIQUIDITY"));
  const rows = useMemo(() => (intel.data ? topOpportunities(intel.data, 40).filter((r) => matches(r.intent)).slice(0, 4) : []), [intel.data, intent]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = (i: number) => {
    const r = rows[i];
    if (r && asset) navigate(`/asset/${encodeURIComponent(asset.symbol)}?i=${r.intent}`);
  };
  // Enter pressed while the asset's options are still loading: open the first one when they arrive.
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!pending || !intel.data) return;
    setPending(false);
    if (rows.length) open(0);
  }, [pending, intel.data, rows]); // eslint-disable-line react-hooks/exhaustive-deps

  function complete(a: AssetListItem) {
    const ws = line.trim().split(/\s+/);
    ws[ws.length - 1] = a.symbol;
    setLine(ws.join(" ") + " ");
    setHi(0);
    input.current?.focus();
  }
  function submit(e: FormEvent) {
    e.preventDefault();
    setErr(false);
    const c = parseCommand(line, list ?? []);
    if (hits.length) return complete(hits[hi] ?? hits[0]!);
    if (c.kind === "wallet") return w.usePasted(c.address) ? navigate("/wallet") : setErr(true);
    if (rows.length) return open(0);
    if (asset && !intel.data) return setPending(true);
    if (asset) return;
    setErr(true);
  }
  return (
    <div className="hero-card ht">
      <div className="hero-step">{t("home.c.step")}</div>
      <div className="cmd-q">// {t("home.c.question")}</div>
      <form className={`cmd-line${err ? " err" : ""}`} onSubmit={submit}>
        <span className="cmd-prompt" aria-hidden="true">
          &gt;
        </span>
        <input
          ref={input}
          value={line}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-label={t("home.cmd.label")}
          placeholder={t("home.c.placeholder")}
          onChange={(e) => (setLine(e.target.value.slice(0, 120)), setErr(false), setHi(0))}
          onKeyDown={(e) => {
            if (!hits.length) return;
            if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, hits.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
            else if (e.key === "Tab") (e.preventDefault(), complete(hits[hi] ?? hits[0]!));
          }}
        />
        <AssetPicker
          label={t("home.pickAsset")}
          placeholder={t("home.c.pick")}
          value={asset}
          onChange={(a) => {
            setPicked(a);
            // Keep the verb; the picked asset replaces any typed one.
            setLine(verb ? `${words[0]} ` : "");
            input.current?.focus();
          }}
        />
        {hits.length > 0 && (
          <div className="cmd-pop" role="listbox">
            {hits.map((a, i) => (
              <button key={a.key} type="button" role="option" aria-selected={i === hi} className={i === hi ? "on" : undefined} onMouseEnter={() => setHi(i)} onClick={() => complete(a)}>
                <Avatar symbol={a.symbol} address={a.address} />
                <span className="s">{a.symbol}</span>
                <span className="n">{a.name.replace(/\s*•\s*Robinhood Token$/i, "")}</span>
              </button>
            ))}
          </div>
        )}
      </form>
      {err && <div className="cmd-err">{t("home.cmd.unknown")}</div>}
      <div className="cmd-examples">
        {EXAMPLES.map((x) => (
          <button
            key={x.text}
            type="button"
            className={verb && VERBS[x.verb] === verb ? "on" : undefined}
            onClick={() => {
              setLine(`${x.text} ${typed ? typed.symbol + " " : ""}`);
              input.current?.focus();
            }}
          >
            &gt; {x.text}
          </button>
        ))}
      </div>

      <div className={`cr-wrap${asset ? " open" : ""}`} aria-live="polite">
        <div className="cr-clip">
          {asset && (
            <div className="cmd-result" key={`${asset.key}|${intent ?? "ALL"}`}>
              <div className="cr-head">
                <span>{t("home.c.result")} ·</span>
                <span className="cr-asset">
                  <Avatar symbol={asset.symbol} address={asset.address} />
                  {asset.symbol}
                </span>
                {intel.data && <span>{t("home.c.count", { n: rows.length })}</span>}
                {intent && <span className="cr-intent">{t(`intent.${intent}`)}</span>}
                <span className="spacer" />
                <button type="button" className="cr-clear" aria-label={t("modal.close")} onClick={() => (setPicked(null), setLine(verb ? `${words[0]} ` : ""))}>
                  ✕
                </button>
              </div>
              {!intel.data && <div className="cr-scan">{t("home.c.scanning", { s: asset.symbol })}</div>}
              {intel.data && !rows.length && <div className="cr-empty">{t("home.c.none")}</div>}
              {rows.map((r, i) => {
                const { val, unit } = oppValue(t, r.intent, r.card);
                return (
                  <button key={r.card.cardId} type="button" className="cr-row" style={{ animationDelay: `${i * 70}ms` }} onClick={() => open(i)}>
                    <ProtocolLogo name={r.card.protocol.name} size={22} />
                    <span className="p">{r.card.protocol.name}</span>
                    <span className="c">{contextLine(t, r.card)}</span>
                    <span className="spacer" />
                    <span className="v num">
                      {val} <small>{unit}</small>
                    </span>
                    <span className="k">{i === 0 ? "[ENTER]" : `[${i + 1}]`}</span>
                  </button>
                );
              })}
              <TerminalChart asset={asset} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The chosen asset's live price and its real price history (Robinhood bars for Stock Tokens,
 * Chainlink rounds otherwise; the same data as the asset page), under the results.
 */
function TerminalChart({ asset }: { asset: AssetListItem }) {
  const { t } = useI18n();
  const live = useLive({ prices: [asset.key] });
  const lp = live.prices.get(asset.key);
  const mv = live.moves.get(asset.key);
  const flash = mv && Date.now() - mv.at < 1500 ? (mv.dir > 0 ? " up" : " down") : "";
  const today = useTodayChange(asset.key);
  return (
    <div className="tchart">
      <div className="tc-head">
        <span className="tc-sym">{asset.symbol}</span>
        <span className="tc-name">{asset.name.replace(/\s*•\s*Robinhood Token$/i, "")}</span>
        <span className="spacer" />
        {lp && <span className={`tc-px num${flash}`}>{usd(lp.usd)}</span>}
        {today !== null && (
          <span className={`num ${today >= 0 ? "up" : "down"}`}>
            {today >= 0 ? "+" : ""}
            {pct(today, 2)} {t("asset.today")}
          </span>
        )}
        <a className="tc-open" {...linkProps(`/asset/${encodeURIComponent(asset.symbol)}`)}>
          {t("home.c.openAsset")} →
        </a>
      </div>
      <PriceChart key={asset.key} assetRef={asset.address} />
    </div>
  );
}

/** Status line shared by Home and Terminal: asset and protocol counts and the live state (the block is in the header). */
export function StatusLine({ protocols }: { protocols: number | null }) {
  const { t } = useI18n();
  const list = useAssetList();
  const live = useLive({});
  return (
    <div className="cmd-status">
      <span>{t("home.cmd.assets", { n: list?.length ?? "…" })}</span>
      {protocols !== null && <span>{t("home.cmd.protocols", { n: protocols })}</span>}
      <span className={`cmd-live${live.connected ? " on" : ""}`}>
        <span className={`live-dot${live.connected ? " on" : ""}`} aria-hidden="true" />
        {t("home.cmd.live")}
      </span>
    </div>
  );
}
