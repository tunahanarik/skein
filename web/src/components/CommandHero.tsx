import { useMemo, useRef, useState, type FormEvent } from "react";
import { api, type AssetListItem } from "../api";
import { topOpportunities, type IntentKey } from "../intents";
import { contextLine } from "../text";
import { useI18n } from "../i18n";
import { useLive } from "../live";
import { navigate } from "../router";
import { useWallet } from "../wallet";
import { Avatar, useAssetList, useAsync } from "./common";
import { Icon, ProtocolLogo, type IconName } from "./icons";
import { AssetPicker, oppValue, useQuick } from "./market";

/** What a line typed into the command bar means. Wallet addresses come first: Skein is a wallet explorer. */
export type Command =
  | { kind: "wallet"; address: string }
  | { kind: "intent"; intent: "EARN" | "FIXED" | "BORROW" | "LIQUIDITY"; asset: AssetListItem }
  | { kind: "swap"; asset: AssetListItem | null }
  | { kind: "bridge" }
  | { kind: "asset"; asset: AssetListItem }
  | { kind: "none" };

const VERBS: Record<string, "EARN" | "FIXED" | "BORROW" | "LIQUIDITY" | "SWAP" | "BRIDGE"> = {
  earn: "EARN", kazan: "EARN", yield: "EARN", getiri: "EARN",
  fixed: "FIXED", sabit: "FIXED",
  borrow: "BORROW", "borç": "BORROW", borc: "BORROW",
  lp: "LIQUIDITY", liquidity: "LIQUIDITY", likidite: "LIQUIDITY",
  swap: "SWAP", takas: "SWAP", trade: "SWAP",
  bridge: "BRIDGE", "köprü": "BRIDGE", kopru: "BRIDGE",
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
  if (verb === "BRIDGE") return { kind: "bridge" };
  if (verb === "SWAP") return { kind: "swap", asset };
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
  { text: "swap", verb: "swap" },
  { text: "bridge", verb: "bridge" },
];

const WHY: { icon: IconName; title: "home.w.b1t" | "home.w.b2t" | "home.w.b3t" | "home.w.b4t"; text: "home.w.b1d" | "home.w.b2d" | "home.w.b3d" | "home.w.b4d" }[] = [
  { icon: "earn", title: "home.w.b1t", text: "home.w.b1d" },
  { icon: "bank", title: "home.w.b2t", text: "home.w.b2d" },
  { icon: "chart", title: "home.w.b3t", text: "home.w.b3d" },
  { icon: "shield", title: "home.w.b4t", text: "home.w.b4d" },
];

/** Left: why and how to explore a wallet (the main use). */
function WalletResearch() {
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
      <div className="hero-step">01 · {t("home.w.step")}</div>
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
      <div className="hw-or">
        <span>{t("home.w.or")}</span>
        {w.address && w.source === "connected" ? (
          <button className="btn small" onClick={() => navigate("/wallet")}>
            {t("walletEntry.open")}
          </button>
        ) : (
          <button className="btn small" disabled={w.connecting} onClick={w.openPicker}>
            {w.connecting ? t("walletEntry.waiting") : t("walletEntry.use")}
          </button>
        )}
      </div>
      <div className="cmd-note">{t("walletEntry.footnote")}</div>
    </div>
  );
}

/** Right: the command terminal; results update live for the asset the user names or picks. */
function CommandTerminal() {
  const { t } = useI18n();
  const list = useAssetList();
  const quick = useQuick();
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
  const intent: IntentKey | null = verb && verb !== "SWAP" && verb !== "BRIDGE" ? verb : null;

  const last = line.endsWith(" ") ? "" : (words.at(-1) ?? "");
  const hits = useMemo(() => {
    const q = last.toLowerCase();
    if (!list || !q || q.startsWith("0x") || VERBS[q] || FILLER.has(q) || typed?.symbol.toLowerCase() === q) return [];
    const rank = (a: AssetListItem) => (a.symbol.toLowerCase() === q ? 0 : a.symbol.toLowerCase().startsWith(q) ? 1 : a.name.toLowerCase().startsWith(q) ? 2 : 9);
    return list.filter((a) => rank(a) < 9).sort((a, b) => rank(a) - rank(b) || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol)).slice(0, 6);
  }, [list, last, typed]);

  const intel = useAsync((sig) => (asset ? api.asset(asset.address, {}, sig) : Promise.resolve(null)), [asset?.key]);
  const rows = useMemo(() => (intel.data ? topOpportunities(intel.data, 40).filter((r) => !intent || r.intent === intent).slice(0, 4) : []), [intel.data, intent]);
  const open = (i: number) => {
    const r = rows[i];
    if (r && asset) navigate(`/asset/${encodeURIComponent(asset.symbol)}?i=${r.intent}`);
  };

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
    if (verb === "BRIDGE") return quick.open("bridge");
    if (verb === "SWAP") return quick.open("swap", asset?.symbol);
    if (rows.length) return open(0);
    setErr(true);
  }
  return (
    <div className="hero-card ht">
      <div className="hero-step">02 · {t("home.c.step")}</div>
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
              if (x.verb === "bridge") return quick.open("bridge");
              setLine(`${x.text} ${typed ? typed.symbol + " " : ""}`);
              input.current?.focus();
            }}
          >
            &gt; {x.text}
          </button>
        ))}
      </div>

      <div className="cmd-result" aria-live="polite">
        <div className="cr-head">
          <span>{t("home.c.result")} ·</span>
          <AssetPicker label={t("home.pickAsset")} placeholder={t("home.c.pick")} value={asset} onChange={(a) => (setPicked(a), typed && setLine(verb ? `${words[0]} ` : ""))} />
          {asset && intel.data && <span>{t("home.c.count", { n: rows.length })}</span>}
          {intent && <span className="cr-intent">{t(`intent.${intent}`)}</span>}
        </div>
        {!asset && <div className="cr-empty">{t("home.c.pickHint")}</div>}
        {asset && !intel.data && <div className="cr-empty">…</div>}
        {asset && intel.data && !rows.length && <div className="cr-empty">{t("home.c.none")}</div>}
        {rows.map((r, i) => {
          const { val, unit } = oppValue(t, r.intent, r.card);
          return (
            <button key={r.card.cardId} type="button" className="cr-row" onClick={() => open(i)}>
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
      </div>
    </div>
  );
}

/**
 * The home hero: why and how to explore a wallet (left), and a command terminal whose results update
 * live for the asset the user chooses (right). Read-only; nothing is signed here.
 */
export function CommandHero({ protocols }: { protocols: number | null }) {
  const { t } = useI18n();
  const list = useAssetList();
  const live = useLive({});
  return (
    <section className="cmd-hero">
      <div className="cmd-status">
        <span className="wordmark">
          skein<span className="sl">/</span>
        </span>
        <span className="spacer" />
        {live.block && (
          <span>
            {t("home.cmd.block")} {Number(live.block).toLocaleString("en-US")}
          </span>
        )}
        <span>{t("home.cmd.assets", { n: list?.length ?? "…" })}</span>
        {protocols !== null && <span>{t("home.cmd.protocols", { n: protocols })}</span>}
        <span className={`cmd-live${live.connected ? " on" : ""}`}>● {t("home.cmd.live")}</span>
      </div>
      <div className="hero-grid">
        <WalletResearch />
        <CommandTerminal />
      </div>
    </section>
  );
}
