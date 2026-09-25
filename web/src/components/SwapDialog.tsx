import { useCallback, useEffect, useState } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import type { Card } from "../api";
import { amount, pct, pctE18 } from "../format";
import { useI18n } from "../i18n";
import { allowance, balanceOf, errorKind, freshQuote, send, simulate, switchToRobinhood, waitReceipt } from "../swap/rpc";
import { approveTx, CHAIN_ID, executableRoute, explorerTx, minOut, swapTx } from "../swap/uniswap";
import { useWallet } from "../wallet";
import { Modal } from "./Modal";

const SLIPPAGES = [10, 50, 100, 300] as const; // basis points
const DEADLINE_S = 600;

type Step =
  | { k: "idle" }
  | { k: "wallet"; what: "approve" | "swap" }
  | { k: "pending"; what: "approve" | "swap"; hash: Hex }
  | { k: "done"; hash: Hex }
  | { k: "error"; kind: ReturnType<typeof errorKind> | "FAILED"; msg?: string; hash?: Hex };

/** Whether a route card can be swapped in-app (Uniswap v3 hops with a quote). */
export function canSwap(c: Card): boolean {
  return !!c.trade?.quote && executableRoute(c.trade.route).ok;
}

export function SwapDialog({ card, onClose }: { card: Card; onClose: () => void }) {
  const { t } = useI18n();
  const w = useWallet();
  const q = card.trade!.quote!;
  const ex = executableRoute(card.trade!.route);
  const route = ex.ok ? ex.route : null;
  const inA = q.input.asset;
  const outA = q.expectedOutput.asset;
  const amountIn = BigInt(q.input.raw);
  const user = w.source === "connected" ? (w.address as Address | null) : null;
  const onChain = w.chainId === CHAIN_ID;

  const [slip, setSlip] = useState<number>(50);
  const [state, setState] = useState<{ balance: bigint; allowance: bigint; out: bigint } | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [step, setStep] = useState<Step>({ k: "idle" });
  const [ack, setAck] = useState(false);
  const highImpact = q.priceImpactClass === "HIGH" || q.priceImpactClass === "EXTREME";

  const load = useCallback(async () => {
    if (!w.provider || !user || !route || !onChain) return;
    setLoading(true);
    setLoadErr(null);
    try {
      const [balance, allow, out] = await Promise.all([balanceOf(w.provider, route.tokens[0]!, user), allowance(w.provider, route.tokens[0]!, user), freshQuote(w.provider, route, amountIn)]);
      setState({ balance, allowance: allow, out });
    } catch (e) {
      setLoadErr(clean(e));
    } finally {
      setLoading(false);
    }
  }, [w.provider, user, route, onChain, amountIn]);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.provider, user, onChain]);

  const busy = step.k === "wallet" || step.k === "pending" || loading;
  const needsApproval = state ? state.allowance < amountIn : false;
  const enough = state ? state.balance >= amountIn : false;
  // Before a fresh on-chain quote exists, the minimum is derived from the listed quote.
  const min = minOut(state ? state.out : BigInt(q.expectedOutput.raw), slip);
  const fmtOut = (v: bigint) => `${amount(formatUnits(v, outA.decimals))} ${outA.symbol}`;

  async function run(what: "approve" | "swap") {
    if (!w.provider || !user || !route) return;
    const p = w.provider;
    try {
      let tx;
      if (what === "approve") {
        tx = approveTx(user, route.tokens[0]!, amountIn);
      } else {
        // Re-quote right before signing; the minimum is derived from this fresh number.
        const out = await freshQuote(p, route, amountIn);
        setState((s) => (s ? { ...s, out } : s));
        const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_S);
        tx = swapTx({ from: user, route, amountIn, minOut: minOut(out, slip), deadline });
        await simulate(p, tx);
      }
      setStep({ k: "wallet", what });
      const hash = await send(p, tx, { user, route });
      setStep({ k: "pending", what, hash });
      const ok = await waitReceipt(p, hash);
      if (!ok) return setStep({ k: "error", kind: "FAILED", hash });
      if (what === "approve") {
        setStep({ k: "idle" });
        await load();
      } else setStep({ k: "done", hash });
    } catch (e) {
      setStep({ k: "error", kind: errorKind(e), msg: clean(e) });
    }
  }

  const txLink = (h?: Hex) => {
    const u = h ? explorerTx(h) : null;
    return u ? (
      <a href={u} target="_blank" rel="noopener noreferrer">
        {t("swap.viewTx")}
      </a>
    ) : null;
  };

  return (
    <Modal title={t("swap.title", { a: inA.symbol, b: outA.symbol })} onClose={onClose}>
      <div className="swap">
        <div className="kv">
          <span className="muted">{t("swap.route")}</span>
          <span className="path">{card.trade!.route.path.map((a) => a.symbol).join(" → ")} · Uniswap v3</span>
          <span className="muted">{t("swap.youPay")}</span>
          <strong className="num">
            {amount(q.input.display)} {inA.symbol}
          </strong>
          <span className="muted">{t("swap.expected")}</span>
          <strong className="num">{state ? fmtOut(state.out) : loading ? "…" : `${amount(q.expectedOutput.display)} ${outA.symbol}`}</strong>
          <span className="muted">{t("route.impact")}</span>
          <span className="num">{q.priceImpact != null ? pctE18(q.priceImpact) : "—"}</span>
          <span className="muted">{t("swap.minReceived")}</span>
          <span className="num">{fmtOut(min)}</span>
        </div>

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
          <div className="faint small" style={{ marginTop: 6 }}>
            {t("swap.deadline", { m: DEADLINE_S / 60 })}
          </div>
        </div>

        {highImpact && (
          <label className="notice warn small" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>{t("swap.impactWarn", { x: q.priceImpact != null ? pctE18(q.priceImpact) : "?" })}</span>
          </label>
        )}

        {!route ? (
          <div className="notice warn small">{t("swap.venueOnly")}</div>
        ) : !user ? (
          <div style={{ display: "grid", gap: 8 }}>
            {w.source === "pasted" && <div className="muted small">{t("swap.pasted")}</div>}
            <button className="btn primary" onClick={w.openPicker}>
              {t("shell.connect")}
            </button>
          </div>
        ) : !onChain ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div className="notice warn small">{t("swap.wrongNetwork")}</div>
            <button className="btn primary" onClick={() => w.provider && switchToRobinhood(w.provider).catch((e) => setStep({ k: "error", kind: errorKind(e), msg: clean(e) }))}>
              {t("swap.switch")}
            </button>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {state && (
              <div className="small muted">
                {t("swap.balance", { x: `${amount(formatUnits(state.balance, inA.decimals))} ${inA.symbol}` })}
                {" · "}
                <button className="linkish" onClick={() => void load()} disabled={busy}>
                  {t("swap.refresh")}
                </button>
              </div>
            )}
            {loadErr && <div className="notice bad small">{t("swap.err.OTHER", { m: loadErr })}</div>}
            {state && !enough && <div className="notice bad small">{t("swap.insufficient", { s: inA.symbol })}</div>}
            {state && enough && step.k !== "done" && (
              <>
                {needsApproval && (
                  <>
                    <button className="btn primary" disabled={busy} onClick={() => void run("approve")}>
                      {step.k === "wallet" && step.what === "approve" ? t("swap.confirmWallet") : step.k === "pending" && step.what === "approve" ? t("swap.approving") : t("swap.approve", { s: inA.symbol })}
                    </button>
                    <div className="faint small">{t("swap.approveNote")}</div>
                  </>
                )}
                <button className="btn primary" disabled={busy || needsApproval || (highImpact && !ack)} onClick={() => void run("swap")}>
                  {step.k === "wallet" && step.what === "swap" ? t("swap.confirmWallet") : step.k === "pending" && step.what === "swap" ? t("swap.swapping") : needsApproval ? t("swap.swapStep") : t("swap.swap")}
                </button>
              </>
            )}
            {step.k === "pending" && <div className="small muted">{txLink(step.hash)}</div>}
            {step.k === "done" && (
              <div className="notice ok small" role="status">
                {t("swap.done")} {txLink(step.hash)}
              </div>
            )}
            {step.k === "error" && (
              <div className="notice bad small" role="alert">
                {step.kind === "FAILED" ? t("swap.failed") : step.kind === "OTHER" ? t("swap.err.OTHER", { m: step.msg ?? "" }) : t(`swap.err.${step.kind}`)} {txLink(step.hash)}
              </div>
            )}
          </div>
        )}
        <div className="faint small">{t("swap.note")}</div>
      </div>
    </Modal>
  );
}

/** Wallet/RPC messages are external text: one line, no control characters, bounded. */
function clean(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  return m.replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, " ").slice(0, 160);
}
