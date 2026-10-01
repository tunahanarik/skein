import { useEffect, useMemo, useRef, useState } from "react";
import type { AssetListItem } from "../api";
import { useI18n } from "../i18n";
import { useLive } from "../live";
import { navigate } from "../router";
import { useWallet } from "../wallet";
import { Avatar, useAssetList } from "./common";
import { Icon } from "./icons";
import { useQuick } from "./market";

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

const EXAMPLES = ["earn NVDA", "swap TSLA", "borrow SPY", "fixed SGOV", "bridge"];

/**
 * The home hero: one command line. Paste a wallet address to see what it holds and what each asset
 * can do (the main use), or type an asset or a short command. Read-only until the user signs elsewhere.
 */
export function CommandHero({ onAsset }: { onAsset: (a: AssetListItem) => void }) {
  const { t } = useI18n();
  const list = useAssetList();
  const w = useWallet();
  const quick = useQuick();
  const live = useLive({});
  const [line, setLine] = useState("");
  const [err, setErr] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const last = line.trim().split(/\s+/).at(-1) ?? "";
  const hits = useMemo(() => {
    const s = last.toLowerCase();
    if (!list || !s || s.startsWith("0x") || VERBS[s]) return [];
    // Exact symbol, then symbol prefix (shortest first), then name prefix.
    const rank = (a: AssetListItem) => (a.symbol.toLowerCase() === s ? 0 : a.symbol.toLowerCase().startsWith(s) ? 1 : a.name.toLowerCase().startsWith(s) ? 2 : 9);
    return list
      .filter((a) => rank(a) < 9)
      .sort((a, b) => rank(a) - rank(b) || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol))
      .slice(0, 6);
  }, [list, last]);
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(line.trim());

  function run(text = line) {
    const c = parseCommand(text, list ?? []);
    setErr(false);
    if (c.kind === "wallet") {
      if (w.usePasted(c.address)) navigate("/wallet");
      else setErr(true);
    } else if (c.kind === "intent") navigate(`/asset/${encodeURIComponent(c.asset.symbol)}?i=${c.intent}`);
    else if (c.kind === "swap") quick.open("swap", c.asset?.symbol);
    else if (c.kind === "bridge") quick.open("bridge");
    else if (c.kind === "asset") {
      onAsset(c.asset);
      setLine("");
      document.getElementById("asset-stage")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else setErr(true);
  }
  /** Replace the word being typed with the asset; Enter and clicks also run the line, Tab only completes. */
  function complete(a: AssetListItem, andRun: boolean) {
    const words = line.trim().split(/\s+/);
    words[words.length - 1] = a.symbol;
    const next = words.join(" ");
    setLine(next + " ");
    input.current?.focus();
    if (andRun) run(next);
  }

  return (
    <section className="cmd-hero">
      <div className="cmd-status">
        <span className="wordmark">
          skein<span className="sl">/</span>
        </span>
        <span className="spacer" />
        <span>{t("home.cmd.assets", { n: list?.length ?? "…" })}</span>
        {live.block && (
          <span>
            {t("home.cmd.block")} {Number(live.block).toLocaleString("en-US")}
          </span>
        )}
        <span className={`cmd-live${live.connected ? " on" : ""}`}>● {t("home.cmd.live")}</span>
      </div>

      <div className="cmd-q">// {t("home.cmd.question")}</div>
      <form
        className={`cmd-line${err ? " err" : ""}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (hits.length && !isAddr) complete(hits[hi] ?? hits[0]!, true);
          else run();
        }}
      >
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
          placeholder={t("home.cmd.placeholder")}
          onChange={(e) => (setLine(e.target.value.slice(0, 120)), setErr(false), setHi(0))}
          onKeyDown={(e) => {
            if (!hits.length) return;
            if (e.key === "ArrowDown") (e.preventDefault(), setHi((h) => Math.min(h + 1, hits.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)));
            else if (e.key === "Tab") (e.preventDefault(), complete(hits[hi] ?? hits[0]!, false));
          }}
        />
        <button type="submit" className={`btn primary cmd-go${isAddr ? " wallet" : ""}`}>
          {isAddr ? t("home.cmd.analyze") : t("home.cmd.run")} ↵
        </button>
        {hits.length > 0 && (
          <div className="cmd-pop" role="listbox">
            {hits.map((a, i) => (
              <button key={a.key} type="button" role="option" aria-selected={i === hi} className={i === hi ? "on" : undefined} onMouseEnter={() => setHi(i)} onClick={() => complete(a, true)}>
                <Avatar symbol={a.symbol} address={a.address} />
                <span className="s">{a.symbol}</span>
                <span className="n">{a.name.replace(/\s*•\s*Robinhood Token$/i, "")}</span>
              </button>
            ))}
          </div>
        )}
      </form>
      {err && <div className="cmd-err">{t("home.cmd.unknown")}</div>}

      <div className="cmd-wallet">
        <Icon name="wallet" size={16} />
        <span>{t("home.cmd.walletLead")}</span>
        <span className="spacer" />
        {w.address && w.source === "connected" ? (
          <button className="btn small" onClick={() => navigate("/wallet")}>
            {t("walletEntry.open")}
          </button>
        ) : (
          <button className="btn small primary" disabled={w.connecting} onClick={w.openPicker}>
            {w.connecting ? t("walletEntry.waiting") : t("walletEntry.use")}
          </button>
        )}
      </div>

      <div className="cmd-examples">
        <span className="m">{t("home.cmd.try")}</span>
        {EXAMPLES.map((x) => (
          <button key={x} type="button" onClick={() => (setLine(x), run(x))}>
            &gt; {x}
          </button>
        ))}
      </div>
      <div className="cmd-note">{t("walletEntry.footnote")}</div>
    </section>
  );
}
