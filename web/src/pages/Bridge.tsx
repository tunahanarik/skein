import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { allowanceData, approveData, balanceData, chains as fetchChains, checkBridgeQuote, NATIVE, quote as fetchQuote, scanUrl, status as fetchStatus, tokens as fetchTokens, type Chain, type Quote, type QuoteRequest, type Token } from "../bridge/lifi";
import { LIFI_DIAMONDS } from "../bridge/diamonds";
import { Modal } from "../components/Modal";
import { useAssetList } from "../components/common";
import { amount, pct, usd } from "../format";
import { useI18n } from "../i18n";
import { chainIdOf, errorKind, switchChain, waitReceipt } from "../swap/rpc";
import { useWallet, type Eip1193 } from "../wallet";

const RH = 4663;
const SLIPPAGES = [10, 50, 100, 300] as const; // bps
/** Shown first in token lists, in this order (by symbol). */
const MAJOR = ["ETH", "WETH", "USDC", "USDT", "USDG", "DAI", "WBTC", "cbBTC", "USDe", "BNB", "POL", "AVAX"];
/** Quotes shown before a wallet is connected are built for this throwaway address (display only). */
const PREVIEW: Address = "0x00000000000000000000000000000000c0ffee01";

type Step =
  | { k: "idle" }
  | { k: "wallet"; what: "approve" | "bridge" }
  | { k: "pending"; what: "approve" | "bridge"; hash: Hex }
  | { k: "bridging"; hash: Hex; q: Quote; recv: Hex | null; sub: string }
  | { k: "done"; hash: Hex; recv: Hex | null }
  | { k: "error"; msg: string; hash?: Hex };

function sortTokens(list: Token[]): Token[] {
  const rank = (t: Token) => (t.address === NATIVE ? -1 : MAJOR.includes(t.symbol) ? MAJOR.indexOf(t.symbol) : 999);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.symbol.localeCompare(b.symbol));
}

/** Robinhood Chain side: only the native coin and canonical registry assets (look-alikes dropped). */
function useChainTokens(chainId: number | null, canonical: Set<string> | null) {
  const [list, setList] = useState<Token[] | null>(null);
  useEffect(() => {
    if (!chainId) return;
    const ac = new AbortController();
    setList(null);
    fetchTokens(chainId, ac.signal)
      .then((l) => setList(sortTokens(chainId === RH ? l.filter((t) => t.address === NATIVE || canonical?.has(t.address.toLowerCase())) : l.filter((t) => t.verified || t.address === NATIVE))))
      .catch((e) => (e as Error).name !== "AbortError" && setList([]));
    return () => ac.abort();
  }, [chainId, canonical]);
  return list;
}

const img = (u: string) => `/api/img?u=${encodeURIComponent(u)}`;

/** Token logo: our verified logo on Robinhood Chain, else LI.FI's (through /api/img), else a monogram. */
export function TokenIcon({ token, size = 32 }: { token: Pick<Token, "chainId" | "address" | "symbol" | "logo"> | null; size?: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!token) return <span className="ticon mono" style={{ width: size, height: size }} />;
  const src = token.chainId === RH && token.address !== NATIVE ? `/api/logo/${token.address.toLowerCase()}?v=2` : token.logo ? img(token.logo) : null;
  if (src && failed !== src) return <img className="ticon" src={src} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(src)} />;
  return (
    <span className="ticon mono" style={{ width: size, height: size, fontSize: size * 0.34 }} aria-hidden="true">
      {token.symbol.slice(0, 3)}
    </span>
  );
}

export function ChainIcon({ chain, size = 16 }: { chain: Pick<Chain, "name" | "logo"> | null; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (chain?.logo && !failed) return <img className="cicon" src={img(chain.logo)} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(true)} />;
  return (
    <span className="cicon mono" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden="true">
      {chain?.name.slice(0, 1) ?? "?"}
    </span>
  );
}

/** Network + token chooser: networks on the left, that network's tokens on the right. */
function TokenModal({ title, chains, chainId, canonical, onPick, onClose }: { title: string; chains: Chain[]; chainId: number; canonical: Set<string> | null; onPick: (chainId: number, t: Token) => void; onClose: () => void }) {
  const { t } = useI18n();
  const [cid, setCid] = useState(chainId);
  const [q, setQ] = useState("");
  const list = useChainTokens(cid, canonical);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (s ? (list ?? []).filter((x) => x.symbol.toLowerCase().includes(s) || x.name.toLowerCase().includes(s) || x.address.toLowerCase() === s) : (list ?? [])).slice(0, 200);
  }, [list, q]);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="tmodal">
        <div className="tm-chains" role="listbox" aria-label={t("bridge.network")}>
          {chains.map((c) => (
            <button key={c.id} role="option" aria-selected={c.id === cid} className={c.id === cid ? "on" : undefined} onClick={() => setCid(c.id)}>
              <ChainIcon chain={c} size={20} />
              <span>{c.name}</span>
            </button>
          ))}
        </div>
        <div className="tm-tokens">
          <input className="input" autoFocus placeholder={t("bridge.searchToken")} aria-label={t("bridge.searchToken")} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="tm-list" role="listbox" aria-label={t("bridge.select")}>
            {!list && <div className="muted small" style={{ padding: 10 }}>{t("misc.loading")}</div>}
            {list && !shown.length && <div className="muted small" style={{ padding: 10 }}>—</div>}
            {shown.map((x) => (
              <button key={x.address} role="option" aria-selected={false} className="tm-tok" onClick={() => onPick(cid, x)}>
                <TokenIcon token={x} size={30} />
                <span className="nm">
                  <span className="s">{x.symbol}</span>
                  <span className="n">{x.name}</span>
                </span>
                {x.address !== NATIVE && <span className="a mono">{`${x.address.slice(0, 6)}…${x.address.slice(-4)}`}</span>}
              </button>
            ))}
          </div>
          {cid === RH && <div className="faint small">{t("bridge.rhTokens")}</div>}
        </div>
      </div>
    </Modal>
  );
}

async function readBalance(p: Eip1193, token: Address, owner: Address): Promise<bigint> {
  if (token === NATIVE) return BigInt((await p.request({ method: "eth_getBalance", params: [owner, "latest"] })) as string);
  return BigInt((await p.request({ method: "eth_call", params: [{ to: token, data: balanceData(owner) }, "latest"] })) as string);
}

/** The bridge: amount + token/network on each side, an automatic quote, and one main button. */
export function BridgeForm() {
  const { t } = useI18n();
  const w = useWallet();
  const assets = useAssetList();
  const canonical = useMemo(() => (assets ? new Set(assets.map((a) => a.address.toLowerCase())) : null), [assets]);
  const [chains, setChains] = useState<Chain[] | null>(null);
  const [chainErr, setChainErr] = useState(false);
  const [fromId, setFromId] = useState(8453);
  const [toId, setToId] = useState(RH);
  const fromList = useChainTokens(fromId, canonical);
  const toList = useChainTokens(toId, canonical);
  const [fromTok, setFromTok] = useState<Token | null>(null);
  const [toTok, setToTok] = useState<Token | null>(null);
  const [amt, setAmt] = useState("");
  const [slip, setSlip] = useState<number>(50);
  const [order, setOrder] = useState<"CHEAPEST" | "FASTEST">("CHEAPEST");
  const [settings, setSettings] = useState(false);
  const [picking, setPicking] = useState<"from" | "to" | null>(null);
  const [q, setQ] = useState<Quote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ k: "idle" });
  const [balance, setBalance] = useState<bigint | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const user = w.source === "connected" ? (w.address as Address | null) : null;
  const onFrom = w.chainId === fromId;
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  useEffect(() => {
    const ac = new AbortController();
    fetchChains(ac.signal)
      .then((c) => setChains(c.sort((a, b) => (a.id === RH ? -1 : b.id === RH ? 1 : a.name.localeCompare(b.name)))))
      .catch((e) => (e as Error).name !== "AbortError" && setChainErr(true));
    return () => ac.abort();
  }, []);

  // Default token per side: keep the same symbol when possible, else the native coin.
  useEffect(() => {
    if (fromList) setFromTok((cur) => (cur && cur.chainId === fromId ? cur : (fromList.find((x) => x.symbol === cur?.symbol) ?? fromList[0] ?? null)));
  }, [fromList, fromId]);
  useEffect(() => {
    if (toList) setToTok((cur) => (cur && cur.chainId === toId ? cur : (toList.find((x) => x.symbol === cur?.symbol) ?? toList[0] ?? null)));
  }, [toList, toId]);

  useEffect(() => {
    setBalance(null);
    if (!w.provider || !user || !onFrom || !fromTok) return;
    readBalance(w.provider, fromTok.address, user).then((b) => live.current && setBalance(b), () => undefined);
  }, [w.provider, user, onFrom, fromTok, step.k]);

  const amountRaw = useMemo(() => {
    if (!fromTok || !/^\d+(\.\d+)?$/.test(amt)) return null;
    try {
      const v = parseUnits(amt, fromTok.decimals);
      return v > 0n ? v : null;
    } catch {
      return null;
    }
  }, [amt, fromTok]);

  const request = (who: Address | null): QuoteRequest | null =>
    fromTok && toTok && amountRaw && who && fromTok.chainId === fromId && toTok.chainId === toId ? { fromChainId: fromId, toChainId: toId, fromToken: fromTok.address, toToken: toTok.address, fromAmount: amountRaw, user: who, slippage: slip / 10_000, order } : null;

  // Automatic quote (debounced). Without a wallet the quote is built for a throwaway address and only displayed.
  useEffect(() => {
    setQ(null);
    setQuoteErr(null);
    const req = request(user ?? PREVIEW);
    if (!req || step.k === "wallet" || step.k === "pending" || step.k === "bridging") return;
    const ac = new AbortController();
    setQuoting(true);
    const tm = setTimeout(() => {
      fetchQuote(req, ac.signal)
        .then((fresh) => {
          checkBridgeQuote(fresh, req);
          if (live.current) setQ(fresh);
        })
        .catch((e) => (e as Error).name !== "AbortError" && live.current && setQuoteErr(short(e)))
        .finally(() => live.current && !ac.signal.aborted && setQuoting(false));
    }, 600);
    return () => {
      clearTimeout(tm);
      ac.abort();
      setQuoting(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromId, toId, fromTok, toTok, amountRaw, slip, order, user]);

  async function refreshAllowance() {
    if (!w.provider || !user || !fromTok || fromTok.address === NATIVE || !onFrom) return setAllowance(null);
    const r = (await w.provider.request({ method: "eth_call", params: [{ to: fromTok.address, data: allowanceData(user, LIFI_DIAMONDS[fromId]!.diamond) }, "latest"] })) as string;
    if (live.current) setAllowance(BigInt(r));
  }
  useEffect(() => {
    void refreshAllowance().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.provider, user, fromTok, onFrom, fromId]);

  async function send(p: Eip1193, tx: { from: Address; to: Address; data: Hex; value: Hex; gas?: Hex }, chainId: number): Promise<Hex> {
    if ((await chainIdOf(p)) !== chainId) throw new Error("wrong network");
    return (await p.request({ method: "eth_sendTransaction", params: [tx] })) as Hex;
  }

  async function approve() {
    const req = request(user);
    if (!w.provider || !req || req.fromToken === NATIVE) return;
    try {
      setStep({ k: "wallet", what: "approve" });
      const hash = await send(w.provider, { from: req.user, to: req.fromToken, data: approveData(LIFI_DIAMONDS[req.fromChainId]!.diamond, req.fromAmount), value: "0x0" }, req.fromChainId);
      setStep({ k: "pending", what: "approve", hash });
      if (!(await waitReceipt(w.provider, hash))) throw new Error("approval failed");
      setStep({ k: "idle" });
      await refreshAllowance();
    } catch (e) {
      setStep({ k: "error", msg: kindMsg(e) });
    }
  }

  async function bridge() {
    const req = request(user);
    if (!w.provider || !req) return;
    try {
      // Re-quote for the connected address right before signing and re-check everything.
      const fresh = await fetchQuote(req);
      checkBridgeQuote(fresh, req);
      setQ(fresh);
      setStep({ k: "wallet", what: "bridge" });
      const hash = await send(w.provider, { from: fresh.tx.from, to: fresh.tx.to, data: fresh.tx.data, value: fresh.tx.value, ...(fresh.tx.gas ? { gas: fresh.tx.gas } : {}) }, req.fromChainId);
      setStep({ k: "pending", what: "bridge", hash });
      if (!(await waitReceipt(w.provider, hash, 600_000))) return setStep({ k: "error", msg: t("swap.failed"), hash });
      setStep({ k: "bridging", hash, q: fresh, recv: null, sub: "" });
    } catch (e) {
      setStep({ k: "error", msg: kindMsg(e) });
    }
  }

  // Poll LI.FI for the destination side until DONE / FAILED (max 45 min).
  useEffect(() => {
    if (step.k !== "bridging") return;
    let stop = false;
    const until = Date.now() + 45 * 60_000;
    const { hash, q: bq } = step;
    void (async () => {
      while (!stop && Date.now() < until) {
        try {
          const s = await fetchStatus({ txHash: hash, fromChainId: bq.fromChainId, toChainId: bq.toChainId, tool: bq.tool });
          if (stop) return;
          if (s.status === "DONE") return setStep({ k: "done", hash, recv: s.receivingTx });
          if (s.status === "FAILED" || s.status === "INVALID") return setStep({ k: "error", msg: t("bridge.failed", { s: s.substatus || s.status }), hash });
          setStep((cur) => (cur.k === "bridging" ? { ...cur, recv: s.receivingTx, sub: s.substatus } : cur));
        } catch {
          /* keep polling */
        }
        await new Promise((r) => setTimeout(r, 6000));
      }
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.k === "bridging" ? step.hash : null]);

  function kindMsg(e: unknown): string {
    const k = errorKind(e);
    return k === "OTHER" ? t("swap.err.OTHER", { m: short(e) }) : t(`swap.err.${k}`);
  }

  const busy = step.k === "wallet" || step.k === "pending" || step.k === "bridging";
  const needsApproval = !!(user && fromTok && fromTok.address !== NATIVE && allowance !== null && amountRaw && allowance < amountRaw);
  const insufficient = balance !== null && amountRaw !== null && balance < amountRaw + (fromTok?.address === NATIVE && q ? BigInt(q.tx.value) - amountRaw : 0n);
  const chainOf = (id: number) => chains?.find((c) => c.id === id) ?? null;
  const chainName = (id: number) => chainOf(id)?.name ?? LIFI_DIAMONDS[id]?.name ?? String(id);
  const link = (h?: Hex | null) => {
    const u = h ? scanUrl(h) : null;
    return u ? (
      <a href={u} target="_blank" rel="noopener noreferrer">
        {t("bridge.track")}
      </a>
    ) : null;
  };

  function pick(side: "from" | "to", cid: number, tok: Token) {
    setPicking(null);
    const other = side === "from" ? toId : fromId;
    if (cid === other) {
      // Same network on both sides: swap them, like the flip button.
      setFromId(toId);
      setToId(fromId);
      setFromTok(toTok);
      setToTok(fromTok);
    }
    if (side === "from") {
      setFromId(cid);
      setFromTok(tok);
    } else {
      setToId(cid);
      setToTok(tok);
    }
  }

  // A render function, not a component: a component declared here would remount on every render.
  const tokenButton = (side: "from" | "to", tok: Token | null, cid: number) => (
    <button className="tok-btn" onClick={() => setPicking(side)} disabled={busy || !chains} aria-label={side === "from" ? t("bridge.fromToken") : t("bridge.toToken")}>
      <span className="ti-wrap">
        <TokenIcon token={tok} size={30} />
        <span className="badge-chain">
          <ChainIcon chain={chainOf(cid)} size={15} />
        </span>
      </span>
      <span className="tb-txt">
        <span className="s">{tok?.symbol ?? "…"}</span>
        <span className="c">{t("bridge.on", { c: chainName(cid) })}</span>
      </span>
      <span className="chev" aria-hidden="true">
        ▾
      </span>
    </button>
  );

  // One main action, in the order a user meets the requirements.
  let main: { label: string; onClick?: () => void; disabled?: boolean };
  if (!user) main = { label: t("shell.connect"), onClick: w.openPicker };
  else if (!amountRaw) main = { label: t("bridge.enterAmount"), disabled: true };
  else if (step.k === "wallet") main = { label: t("swap.confirmWallet"), disabled: true };
  else if (step.k === "pending") main = { label: step.what === "approve" ? t("swap.approving") : t("bridge.sending"), disabled: true };
  else if (step.k === "bridging") main = { label: t("bridge.inFlightShort"), disabled: true };
  else if (!onFrom) main = { label: t("bridge.switchTo", { c: chainName(fromId) }), onClick: () => w.provider && switchChain(w.provider, fromId, chainOf(fromId)?.addParams ?? null).catch((e) => setStep({ k: "error", msg: kindMsg(e) })) };
  else if (insufficient) main = { label: t("swap.insufficient", { s: fromTok?.symbol ?? "" }), disabled: true };
  else if (quoting) main = { label: t("bridge.finding"), disabled: true };
  else if (!q) main = { label: quoteErr ? t("bridge.noRoute") : t("bridge.finding"), disabled: true };
  else if (needsApproval) main = { label: t("bridge.approve", { s: fromTok?.symbol ?? "" }), onClick: () => void approve() };
  else main = { label: t("bridge.go", { a: chainName(fromId), b: chainName(toId) }), onClick: () => void bridge() };

  const phases = ["approve", "send", "arrive", "done"] as const;
  const at = step.k === "done" ? 4 : step.k === "bridging" ? 2 : (step.k === "wallet" || step.k === "pending") && step.what === "bridge" ? 1 : (step.k === "wallet" || step.k === "pending") && step.what === "approve" ? 0 : -1;

  return (
    <div className="bx">
      {chainErr && <div className="notice bad small">{t("bridge.unavailable")}</div>}

      <div className="bx-head">
        <span className="muted small">{t("bridge.poweredBy")}</span>
        <button className="icon-btn" aria-label={t("bridge.settings")} aria-expanded={settings} title={t("bridge.settings")} onClick={() => setSettings(!settings)}>
          ⚙
        </button>
      </div>
      {settings && (
        <div className="bx-settings">
          <div>
            <div className="muted small">{t("swap.slippage")}</div>
            <div className="seg" role="radiogroup" aria-label={t("swap.slippage")}>
              {SLIPPAGES.map((b) => (
                <button key={b} role="radio" aria-checked={slip === b} className={slip === b ? "on" : undefined} onClick={() => setSlip(b)} disabled={busy}>
                  {pct(b / 100, 2, 0)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="muted small">{t("bridge.prefer")}</div>
            <div className="seg" role="radiogroup" aria-label={t("bridge.prefer")}>
              {(["CHEAPEST", "FASTEST"] as const).map((o) => (
                <button key={o} role="radio" aria-checked={order === o} className={order === o ? "on" : undefined} onClick={() => setOrder(o)} disabled={busy}>
                  {t(o === "CHEAPEST" ? "bridge.cheapest" : "bridge.fastest")}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="bx-row">
        <div className="bx-top">
          <span className="muted small">{t("bridge.from")}</span>
          {balance !== null && fromTok && (
            <span className="muted small">
              {t("swap.balance", { x: amount(formatUnits(balance, fromTok.decimals), 6) })}{" "}
              <button className="linkish" onClick={() => setAmt(formatUnits(balance, fromTok.decimals))} disabled={busy}>
                {t("bridge.max")}
              </button>
            </span>
          )}
        </div>
        <div className="bx-mid">
          <input className="bx-amt num" inputMode="decimal" placeholder="0" aria-label={t("bridge.amount")} value={amt} onChange={(e) => setAmt(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} disabled={busy} />
          {tokenButton("from", fromTok, fromId)}
        </div>
        <div className="muted small">{q?.fromAmountUsd != null ? usd(String(q.fromAmountUsd)) : " "}</div>
      </div>

      <div className="bx-flip">
        <button
          className="icon-btn round"
          aria-label={t("bridge.flip")}
          title={t("bridge.flip")}
          disabled={busy}
          onClick={() => {
            setFromId(toId);
            setToId(fromId);
            setFromTok(toTok);
            setToTok(fromTok);
          }}
        >
          ↓
        </button>
      </div>

      <div className="bx-row">
        <div className="bx-top">
          <span className="muted small">{t("bridge.to")}</span>
        </div>
        <div className="bx-mid">
          <span className={`bx-amt num${q ? "" : " ph"}`} aria-live="polite">
            {q ? amount(formatUnits(q.toAmount, q.toToken.decimals), 6) : quoting ? "…" : "0"}
          </span>
          {tokenButton("to", toTok, toId)}
        </div>
        <div className="muted small">{q?.toAmountUsd != null ? usd(String(q.toAmountUsd)) : " "}</div>
      </div>

      {q && (
        <details className="bx-quote">
          <summary>
            <span>
              {t("bridge.via")} <strong>{q.toolName}</strong> · {q.durationS !== null ? t("bridge.seconds", { n: Math.max(1, Math.round(q.durationS)) }) : "—"} · {t("bridge.feeShort", { x: usd((q.feesUsd + q.gasUsd).toFixed(2)) })}
            </span>
          </summary>
          <div className="kv">
            <span className="muted">{t("swap.minReceived")}</span>
            <span className="num">
              {amount(formatUnits(q.toAmountMin < q.toAmount ? q.toAmountMin : q.toAmount, q.toToken.decimals), 6)} {q.toToken.symbol}
            </span>
            <span className="muted">{t("bridge.fees")}</span>
            <span className="num">
              {usd(String(q.feesUsd))} + {t("bridge.gas", { x: usd(String(q.gasUsd)) })}
            </span>
            {q.extraNativeFee > 0n && (
              <>
                <span className="muted">{t("bridge.extraFee")}</span>
                <span className="num">
                  {amount(formatUnits(q.extraNativeFee, 18))} {LIFI_DIAMONDS[fromId]?.coin}
                </span>
              </>
            )}
          </div>
        </details>
      )}
      {quoteErr && !q && !quoting && amountRaw && <div className="muted small">{quoteErr}</div>}

      <button className="btn primary big" onClick={main.onClick} disabled={main.disabled}>
        {main.label}
      </button>

      {at >= 0 && (
        <div className="bx-steps" role="status">
          {phases.map((p, i) => (
            <span key={p} className={`st ${at > i || at === 4 ? "done" : at === i ? "now" : ""}`}>
              <span className="dotc" aria-hidden="true">
                {at > i || at === 4 ? "✓" : i + 1}
              </span>
              {t(`bridge.phase.${p}`)}
            </span>
          ))}
        </div>
      )}
      {step.k === "bridging" && (
        <div className="notice info small">
          {t("bridge.inFlight")} {step.sub && `(${step.sub})`} {link(step.hash)}
        </div>
      )}
      {step.k === "done" && (
        <div className="notice ok small" role="status">
          {t("bridge.done")} {link(step.recv ?? step.hash)}
        </div>
      )}
      {step.k === "error" && (
        <div className="notice bad small" role="alert">
          {step.msg} {link(step.hash)}
        </div>
      )}

      {picking && chains && (
        <TokenModal
          title={picking === "from" ? t("bridge.fromToken") : t("bridge.toToken")}
          chains={chains}
          chainId={picking === "from" ? fromId : toId}
          canonical={canonical}
          onPick={(cid, tok) => pick(picking, cid, tok)}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  );
}

export function BridgePage() {
  const { t } = useI18n();
  return (
    <div className="bridge-simple">
      <h1>{t("bridge.title")}</h1>
      <p className="muted">{t("bridge.leadShort")}</p>
      <div className="panel pad">
        <BridgeForm />
      </div>
      <details className="more bridge-how">
        <summary>{t("bridge.how")}</summary>
        <div className="body faint small">
          <div>{t("bridge.note1")}</div>
          <div>{t("bridge.note2")}</div>
          <div>
            {t("bridge.canonical")}{" "}
            <a href="https://docs.robinhood.com/chain/bridging/" target="_blank" rel="noopener noreferrer">
              docs.robinhood.com ↗
            </a>
          </div>
        </div>
      </details>
    </div>
  );
}

function short(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return m.replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, " ").slice(0, 160);
}
