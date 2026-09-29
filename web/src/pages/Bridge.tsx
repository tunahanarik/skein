import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { allowanceData, balanceData, chains as fetchChains, checkBridgeQuote, NATIVE, quote as fetchQuote, scanUrl, status as fetchStatus, tokens as fetchTokens, approveData, type Chain, type Quote, type QuoteRequest, type Token } from "../bridge/lifi";
import { LIFI_DIAMONDS } from "../bridge/diamonds";
import { useAssetList } from "../components/common";
import { amount, pct, usd } from "../format";
import { useI18n } from "../i18n";
import { chainIdOf, errorKind, switchChain, waitReceipt } from "../swap/rpc";
import { useWallet, type Eip1193 } from "../wallet";

const RH = 4663;
const SLIPPAGES = [10, 50, 100, 300] as const; // bps
/** Shown first in token lists, in this order (by symbol). */
const MAJOR = ["ETH", "WETH", "USDC", "USDT", "USDG", "DAI", "WBTC", "cbBTC", "USDe", "BNB", "POL", "AVAX"];

type Step =
  | { k: "idle" }
  | { k: "quoting" }
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
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!chainId) return;
    const ac = new AbortController();
    setList(null);
    setErr(false);
    fetchTokens(chainId, ac.signal)
      .then((l) => setList(sortTokens(chainId === RH ? l.filter((t) => t.address === NATIVE || canonical?.has(t.address.toLowerCase())) : l.filter((t) => t.verified || t.address === NATIVE))))
      .catch((e) => (e as Error).name !== "AbortError" && setErr(true));
    return () => ac.abort();
  }, [chainId, canonical]);
  return { list, err };
}

function TokenPicker({ label, list, value, onChange }: { label: string; list: Token[] | null; value: Token | null; onChange: (t: Token) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const l = list ?? [];
    return (s ? l.filter((x) => x.symbol.toLowerCase().includes(s) || x.name.toLowerCase().includes(s) || x.address.toLowerCase() === s) : l).slice(0, 300);
  }, [list, q]);
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <input className="input" placeholder={t("bridge.searchToken")} aria-label={`${label} — ${t("bridge.searchToken")}`} value={q} onChange={(e) => setQ(e.target.value)} disabled={!list} />
      <select
        className="input"
        aria-label={label}
        value={value?.address ?? ""}
        disabled={!list}
        onChange={(e) => {
          const tok = (list ?? []).find((x) => x.address === e.target.value);
          if (tok) onChange(tok);
        }}
      >
        {!list && <option>{t("misc.loading")}</option>}
        {value && !shown.some((x) => x.address === value.address) && <option value={value.address}>{value.symbol}</option>}
        {shown.map((x) => (
          <option key={x.address} value={x.address}>
            {x.symbol}
            {x.name && x.name !== x.symbol ? ` — ${x.name}` : ""}
            {x.address === NATIVE ? "" : ` (${x.address.slice(0, 6)}…${x.address.slice(-4)})`}
          </option>
        ))}
      </select>
    </div>
  );
}

async function readBalance(p: Eip1193, token: Address, owner: Address): Promise<bigint> {
  if (token === NATIVE) return BigInt((await p.request({ method: "eth_getBalance", params: [owner, "latest"] })) as string);
  return BigInt((await p.request({ method: "eth_call", params: [{ to: token, data: balanceData(owner) }, "latest"] })) as string);
}

export interface BridgePreset {
  fromId: number;
  toId: number;
  fromSymbol: string;
  toSymbol: string;
}
/** Where a bridge is, for the progress list next to the form. */
export type BridgePhase = "idle" | "approve" | "send" | "arrive" | "done";

/** Popular routes (chips on the bridge page). */
export const POPULAR: BridgePreset[] = [
  { fromId: 1, toId: RH, fromSymbol: "ETH", toSymbol: "ETH" },
  { fromId: 8453, toId: RH, fromSymbol: "USDC", toSymbol: "USDG" },
  { fromId: 42161, toId: RH, fromSymbol: "USDC", toSymbol: "USDG" },
  { fromId: RH, toId: 8453, fromSymbol: "USDG", toSymbol: "USDC" },
];

/** The bridge form: chains, tokens, amount, quote, approve, send, track. */
export function BridgeForm({ initial, onPhase }: { initial?: BridgePreset | null; onPhase?: (p: BridgePhase) => void }) {
  const { t } = useI18n();
  const w = useWallet();
  const assets = useAssetList();
  const canonical = useMemo(() => (assets ? new Set(assets.map((a) => a.address.toLowerCase())) : null), [assets]);
  const [chains, setChains] = useState<Chain[] | null>(null);
  const [chainErr, setChainErr] = useState(false);
  const [fromId, setFromId] = useState(initial?.fromId ?? 8453);
  const [toId, setToId] = useState(initial?.toId ?? RH);
  const from = useChainTokens(fromId, canonical);
  const to = useChainTokens(toId, canonical);
  const [fromTok, setFromTok] = useState<Token | null>(null);
  const [toTok, setToTok] = useState<Token | null>(null);
  // Token symbols asked for by a preset; used once, when that chain's list first arrives.
  const want = useRef<{ from: string | null; to: string | null }>({ from: initial?.fromSymbol ?? null, to: initial?.toSymbol ?? null });
  const [amt, setAmt] = useState("");
  const [slip, setSlip] = useState<number>(50);
  const [order, setOrder] = useState<"CHEAPEST" | "FASTEST">("CHEAPEST");
  const [q, setQ] = useState<Quote | null>(null);
  const [step, setStep] = useState<Step>({ k: "idle" });
  const [balance, setBalance] = useState<bigint | null>(null);
  const user = w.source === "connected" ? w.address : null;
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

  // Default token per side: the native coin, or keep the same symbol when the chain changes.
  useEffect(() => {
    if (!from.list) return;
    const w = want.current.from;
    want.current.from = null;
    setFromTok((cur) => from.list!.find((x) => x.symbol === (w ?? cur?.symbol)) ?? from.list!.find((x) => x.symbol === cur?.symbol) ?? from.list![0] ?? null);
  }, [from.list]);
  useEffect(() => {
    if (!to.list) return;
    const w = want.current.to;
    want.current.to = null;
    setToTok((cur) => to.list!.find((x) => x.symbol === (w ?? cur?.symbol)) ?? to.list!.find((x) => x.symbol === cur?.symbol) ?? to.list![0] ?? null);
  }, [to.list]);
  useEffect(() => setQ(null), [fromId, toId, fromTok, toTok, amt, slip, order]);

  useEffect(() => {
    setBalance(null);
    if (!w.provider || !user || !onFrom || !fromTok) return;
    readBalance(w.provider, fromTok.address, user as Address).then((b) => live.current && setBalance(b), () => undefined);
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

  const request = (): QuoteRequest | null =>
    fromTok && toTok && amountRaw && user ? { fromChainId: fromId, toChainId: toId, fromToken: fromTok.address, toToken: toTok.address, fromAmount: amountRaw, user: user as Address, slippage: slip / 10_000, order } : null;

  async function getQuote() {
    const req = request();
    if (!req) return;
    setStep({ k: "quoting" });
    try {
      const fresh = await fetchQuote(req);
      checkBridgeQuote(fresh, req);
      if (!live.current) return;
      setQ(fresh);
      setStep({ k: "idle" });
    } catch (e) {
      setStep({ k: "error", msg: short(e) });
    }
  }

  async function send(p: Eip1193, tx: { from: Address; to: Address; data: Hex; value: Hex; gas?: Hex }, chainId: number): Promise<Hex> {
    if ((await chainIdOf(p)) !== chainId) throw new Error("wrong network");
    return (await p.request({ method: "eth_sendTransaction", params: [tx] })) as Hex;
  }

  async function approve() {
    const req = request();
    if (!w.provider || !req || !q || req.fromToken === NATIVE) return;
    const spender = LIFI_DIAMONDS[req.fromChainId]!.diamond;
    try {
      setStep({ k: "wallet", what: "approve" });
      const hash = await send(w.provider, { from: req.user, to: req.fromToken, data: approveData(spender, req.fromAmount), value: "0x0" }, req.fromChainId);
      setStep({ k: "pending", what: "approve", hash });
      if (!(await waitReceipt(w.provider, hash))) throw new Error("approval failed");
      setStep({ k: "idle" });
      await refreshAllowance();
    } catch (e) {
      setStep({ k: "error", msg: kindMsg(e) });
    }
  }

  const [allowance, setAllowance] = useState<bigint | null>(null);
  async function refreshAllowance() {
    if (!w.provider || !user || !fromTok || fromTok.address === NATIVE || !onFrom) return setAllowance(null);
    const spender = LIFI_DIAMONDS[fromId]!.diamond;
    const r = (await w.provider.request({ method: "eth_call", params: [{ to: fromTok.address, data: allowanceData(user as Address, spender) }, "latest"] })) as string;
    if (live.current) setAllowance(BigInt(r));
  }
  useEffect(() => {
    void refreshAllowance().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.provider, user, fromTok, onFrom, fromId]);

  async function bridge() {
    const req = request();
    if (!w.provider || !req) return;
    try {
      // Re-quote right before signing and re-check everything against the request.
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
    const tick = async () => {
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
    };
    void tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step.k === "bridging" ? step.hash : null]);

  function kindMsg(e: unknown): string {
    const k = errorKind(e);
    return k === "OTHER" ? t("swap.err.OTHER", { m: short(e) }) : t(`swap.err.${k}`);
  }

  const busy = step.k === "quoting" || step.k === "wallet" || step.k === "pending" || step.k === "bridging";
  const needsApproval = !!(q && fromTok && fromTok.address !== NATIVE && allowance !== null && amountRaw && allowance < amountRaw);
  const insufficient = balance !== null && amountRaw !== null && balance < amountRaw + (fromTok?.address === NATIVE && q ? BigInt(q.tx.value) - amountRaw : 0n);
  const chainName = (id: number) => chains?.find((c) => c.id === id)?.name ?? LIFI_DIAMONDS[id]?.name ?? String(id);
  const fmt = (v: bigint, tok: Token) => `${amount(formatUnits(v, tok.decimals))} ${tok.symbol}`;
  const link = (h?: Hex | null) => {
    const u = h ? scanUrl(h) : null;
    return u ? (
      <a href={u} target="_blank" rel="noopener noreferrer">
        {t("bridge.track")}
      </a>
    ) : null;
  };

  const ChainSelect = ({ value, onChange, label }: { value: number; onChange: (id: number) => void; label: string }) => (
    <select className="input" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))} disabled={!chains || busy}>
      {(chains ?? [{ id: value, name: chainName(value) } as Chain]).map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );

  const phase: BridgePhase =
    step.k === "done" ? "done" : step.k === "bridging" ? "arrive" : (step.k === "wallet" || step.k === "pending") && step.what === "bridge" ? "send" : (step.k === "wallet" || step.k === "pending") && step.what === "approve" ? "approve" : "idle";
  useEffect(() => onPhase?.(phase), [phase, onPhase]);

  return (
    <>
      {chainErr && <div className="notice bad small">{t("bridge.unavailable")}</div>}

      <div className="panel pad bridge">
        <div className="bridge-side">
          <div className="muted small">{t("bridge.from")}</div>
          <ChainSelect value={fromId} label={t("bridge.fromChain")} onChange={(id) => (id === toId ? (setToId(fromId), setFromId(id)) : setFromId(id))} />
          <TokenPicker label={t("bridge.fromToken")} list={from.list} value={fromTok} onChange={setFromTok} />
          <input className="input num" inputMode="decimal" placeholder="0.0" aria-label={t("bridge.amount")} value={amt} onChange={(e) => setAmt(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))} disabled={busy} />
          {balance !== null && fromTok && (
            <div className="small muted">
              {t("swap.balance", { x: fmt(balance, fromTok) })}{" "}
              <button className="linkish" onClick={() => setAmt(formatUnits(balance, fromTok.decimals))} disabled={busy}>
                {t("bridge.max")}
              </button>
            </div>
          )}
        </div>

        <div style={{ textAlign: "center" }}>
          <button
            className="btn small"
            aria-label={t("bridge.flip")}
            title={t("bridge.flip")}
            disabled={busy}
            onClick={() => {
              setFromId(toId);
              setToId(fromId);
              const ft = fromTok;
              setFromTok(toTok);
              setToTok(ft);
            }}
          >
            ⇅
          </button>
        </div>

        <div className="bridge-side">
          <div className="muted small">{t("bridge.to")}</div>
          <ChainSelect value={toId} label={t("bridge.toChain")} onChange={(id) => (id === fromId ? (setFromId(toId), setToId(id)) : setToId(id))} />
          <TokenPicker label={t("bridge.toToken")} list={to.list} value={toTok} onChange={setToTok} />
          {toId === RH && <div className="faint small">{t("bridge.rhTokens")}</div>}
        </div>

        <details className="more settings">
          <summary>{t("bridge.settings")}</summary>
        <div className="row" style={{ gap: 16, flexWrap: "wrap", marginTop: 10 }}>
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>
              {t("swap.slippage")}
            </div>
            <div className="seg" role="radiogroup" aria-label={t("swap.slippage")}>
              {SLIPPAGES.map((b) => (
                <button key={b} role="radio" aria-checked={slip === b} className={slip === b ? "on" : undefined} onClick={() => setSlip(b)} disabled={busy}>
                  {pct(b / 100, 2, 0)}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>
              {t("bridge.prefer")}
            </div>
            <div className="seg" role="radiogroup" aria-label={t("bridge.prefer")}>
              {(["CHEAPEST", "FASTEST"] as const).map((o) => (
                <button key={o} role="radio" aria-checked={order === o} className={order === o ? "on" : undefined} onClick={() => setOrder(o)} disabled={busy}>
                  {t(o === "CHEAPEST" ? "bridge.cheapest" : "bridge.fastest")}
                </button>
              ))}
            </div>
          </div>
        </div>
        </details>

        {!user ? (
          <button className="btn primary" onClick={w.openPicker}>
            {t("shell.connect")}
          </button>
        ) : !q ? (
          <button className="btn primary" disabled={busy || !amountRaw || !fromTok || !toTok} onClick={() => void getQuote()}>
            {step.k === "quoting" ? t("quote.quoting") : t("bridge.getQuote")}
          </button>
        ) : null}

        {q && fromTok && toTok && (
          <div className="kv bridge-quote">
            <span className="muted">{t("bridge.via")}</span>
            <strong>{q.toolName} · LI.FI</strong>
            <span className="muted">{t("bridge.receive")}</span>
            <strong className="num">
              ≈ {fmt(q.toAmount, q.toToken)}
              {q.toAmountUsd !== null ? ` (${usd(String(q.toAmountUsd))})` : ""}
            </strong>
            <span className="muted">{t("swap.minReceived")}</span>
            <span className="num">{fmt(q.toAmountMin < q.toAmount ? q.toAmountMin : q.toAmount, q.toToken)}</span>
            <span className="muted">{t("bridge.fees")}</span>
            <span className="num">
              {usd(String(q.feesUsd))} + {t("bridge.gas", { x: usd(String(q.gasUsd)) })}
            </span>
            {q.extraNativeFee > 0n && (
              <>
                <span className="muted">{t("bridge.extraFee")}</span>
                <span className="num">{amount(formatUnits(q.extraNativeFee, 18))} {LIFI_DIAMONDS[fromId]?.coin}</span>
              </>
            )}
            <span className="muted">{t("bridge.time")}</span>
            <span className="num">{q.durationS !== null ? t("bridge.seconds", { n: Math.max(1, Math.round(q.durationS)) }) : "—"}</span>
          </div>
        )}

        {q && user && (
          <div style={{ display: "grid", gap: 8 }}>
            {!onFrom ? (
              <button className="btn primary" disabled={busy} onClick={() => w.provider && switchChain(w.provider, fromId, chains?.find((c) => c.id === fromId)?.addParams ?? null).catch((e) => setStep({ k: "error", msg: kindMsg(e) }))}>
                {t("bridge.switchTo", { c: chainName(fromId) })}
              </button>
            ) : insufficient ? (
              <div className="notice bad small">{t("swap.insufficient", { s: fromTok?.symbol ?? "" })}</div>
            ) : (
              <>
                {needsApproval && (
                  <button className="btn primary" disabled={busy} onClick={() => void approve()}>
                    {step.k === "wallet" && step.what === "approve" ? t("swap.confirmWallet") : step.k === "pending" && step.what === "approve" ? t("swap.approving") : t("bridge.approve", { s: fromTok?.symbol ?? "" })}
                  </button>
                )}
                <button className="btn primary" disabled={busy || needsApproval || step.k === "done"} onClick={() => void bridge()}>
                  {step.k === "wallet" && step.what === "bridge" ? t("swap.confirmWallet") : step.k === "pending" && step.what === "bridge" ? t("bridge.sending") : t("bridge.go", { a: chainName(fromId), b: chainName(toId) })}
                </button>
              </>
            )}
            <button className="linkish small" onClick={() => void getQuote()} disabled={busy}>
              {t("bridge.requote")}
            </button>
          </div>
        )}

        {step.k === "bridging" && (
          <div className="notice info small" role="status">
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
      </div>
    </>
  );
}

const PHASES = ["approve", "send", "arrive", "done"] as const;

export function BridgePage() {
  const { t } = useI18n();
  const [preset, setPreset] = useState<BridgePreset | null>(null);
  const [phase, setPhase] = useState<BridgePhase>("idle");
  const at = (PHASES as readonly string[]).indexOf(phase);
  return (
    <div className="bridge-page">
      <div style={{ display: "grid", gap: 14, alignContent: "start" }}>
        <div>
          <h1>{t("bridge.title")}</h1>
          <p className="muted" style={{ margin: "6px 0 0" }}>{t("bridge.lead")}</p>
        </div>
        <BridgeForm key={preset ? `${preset.fromId}-${preset.toId}-${preset.fromSymbol}-${preset.toSymbol}` : "default"} initial={preset} onPhase={setPhase} />
        <div className="row small">
          <span className="muted">{t("bridge.popular")}</span>
          {POPULAR.map((p) => (
            <button key={`${p.fromId}-${p.toId}-${p.fromSymbol}`} className="pill" onClick={() => setPreset({ ...p })}>
              {p.fromSymbol} · {LIFI_DIAMONDS[p.fromId]?.name ?? p.fromId} → {p.toSymbol === p.fromSymbol ? "" : `${p.toSymbol} · `}
              {LIFI_DIAMONDS[p.toId]?.name ?? p.toId}
            </button>
          ))}
        </div>
      </div>
      <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
        <div className="panel pad steps" aria-label={t("bridge.stepsTitle")}>
          <div className="muted small">{t("bridge.stepsTitle")}</div>
          {PHASES.map((p, i) => (
            <div key={p} className={`step ${at > i || phase === "done" ? "done" : at === i ? "now" : ""}`}>
              <span className="dotc" aria-hidden="true">{at > i || phase === "done" ? "✓" : i + 1}</span>
              <span>{t(`bridge.phase.${p}`)}</span>
            </div>
          ))}
          <div className="faint small" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>{t("bridge.next")}</div>
        </div>
        <div className="faint small" style={{ display: "grid", gap: 6 }}>
          <div>{t("bridge.note1")}</div>
          <div>{t("bridge.note2")}</div>
          <div>
            {t("bridge.canonical")}{" "}
            <a href="https://docs.robinhood.com/chain/bridging/" target="_blank" rel="noopener noreferrer">
              docs.robinhood.com ↗
            </a>
          </div>
        </div>
      </aside>
    </div>
  );
}

function short(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return m.replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, " ").slice(0, 160);
}
