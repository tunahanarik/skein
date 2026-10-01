import { useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address, type Hex } from "viem";
import { api, type AggregatorRow } from "../api";
import { allowanceData, approveData, balanceData, checkBridgeQuote, quote as lifiQuote, type Quote, type QuoteRequest } from "../bridge/lifi";
import { LIFI_DIAMONDS } from "../bridge/diamonds";
import { amount, pct, prettyId, usd } from "../format";
import { useI18n } from "../i18n";
import { chainIdOf, errorKind, switchToRobinhood, waitReceipt } from "../swap/rpc";
import { explorerTx } from "../swap/uniswap";
import { checkKyberTx, KYBER_ROUTER, kyberBuild, kyberRoute, type KyberRoute } from "../swap/kyber";
import { useWallet, type Eip1193 } from "../wallet";

const RH = 4663;
const PREVIEW: Address = "0x00000000000000000000000000000000c0ffee01";
/** Loss vs the oracle: ≤ 1% good, ≤ 3% acceptable, above: not executed (src/product/aggregator.ts). */
const GOOD = 0.01;
const MAX = 0.03;
const VERIFIED = new Set(["kyberswap", "openocean", "rialto", "lifiIntentsDex"]);
/** Venues KyberSwap may route through that we have verified (src/product/aggregator.ts). */
const VERIFIED_VENUES = new Set(["uniswap-v3", "uniswapv3", "uniswap-v4", "uniswap-v4-hookless", "ramses", "ramses-v2", "ramses-v3", "ramses-cl", "up-v3", "up-v2", "kittenswap", "alandale", "sushiswap-v3", "pancake-v3"]);
const SLIPPAGE_BPS = 50;

/** One quote, from LI.FI or (fallback) KyberSwap, normalised for display and execution. */
interface AggQuote {
  via: "lifi" | "kyber";
  toolName: string;
  verified: boolean;
  toAmount: bigint;
  toAmountMin: bigint;
  feesUsd: number | null;
  spender: Address;
  lifi?: Quote;
  kyber?: KyberRoute;
}

export interface Tok {
  key: string;
  address: Address;
  symbol: string;
  decimals: number;
}

/* ---------- shared data hooks ---------- */

let aggCache: { at: number; p: Promise<Map<string, AggregatorRow>> } | null = null;
/** The server's aggregator scan, by registry key (refreshed every 5 minutes). */
export function useAggregator(): Map<string, AggregatorRow> | null {
  const [m, setM] = useState<Map<string, AggregatorRow> | null>(null);
  useEffect(() => {
    let live = true;
    if (!aggCache || Date.now() - aggCache.at > 5 * 60_000) {
      aggCache = { at: Date.now(), p: api.aggregator().then((r) => new Map((r.rows ?? []).map((x) => [x.key, x])), () => new Map()) };
    }
    aggCache.p.then((v) => live && setM(v));
    return () => {
      live = false;
    };
  }, []);
  return m;
}

const priceCache = new Map<string, { at: number; p: Promise<number | null> }>();
/** The asset's Chainlink/Phase 1 USD price (cached 60 s). */
export function useUsdPrice(ref: string | null): number | null {
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    if (!ref) return;
    let live = true;
    let hit = priceCache.get(ref);
    if (!hit || Date.now() - hit.at > 60_000) {
      hit = { at: Date.now(), p: api.asset(ref).then((a) => (a.price?.usd ? Number(a.price.usd) : null), () => null) };
      priceCache.set(ref, hit);
    }
    hit.p.then((x) => live && setV(x));
    return () => {
      live = false;
    };
  }, [ref]);
  return v;
}

type Step = { k: "idle" } | { k: "wallet"; what: "approve" | "swap" } | { k: "pending"; what: "approve" | "swap"; hash: Hex } | { k: "done"; hash: Hex } | { k: "error"; msg: string; hash?: Hex };

/**
 * Swap on Robinhood Chain through LI.FI (KyberSwap, OpenOcean, Rialto, Fly, Nordstern, …). The
 * transaction must pass checkBridgeQuote (pinned diamond, amounts, addresses) and lose at most 3%
 * against the Chainlink prices of both tokens; unverified sources need an acknowledgement.
 */
export function AggregatorSwap({ from, to, amountRaw, onOut }: { from: Tok; to: Tok; amountRaw: bigint; onOut?: (out: bigint | null) => void }) {
  const { t } = useI18n();
  const w = useWallet();
  const user = w.source === "connected" ? (w.address as Address | null) : null;
  const fromUsd = useUsdPrice(from.address);
  const toUsd = useUsdPrice(to.address);
  const [q, setQ] = useState<AggQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [step, setStep] = useState<Step>({ k: "idle" });
  const [allow, setAllow] = useState<bigint | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);
  // The parent shows the expected output in its own "You receive" box.
  useEffect(() => onOut?.(q ? q.toAmount : null), [q, onOut]);

  const req = (who: Address): QuoteRequest => ({ fromChainId: RH, toChainId: RH, fromToken: from.address, toToken: to.address, fromAmount: amountRaw, user: who, recipient: who, slippage: 0.005, order: "CHEAPEST" });

  /** LI.FI first (more sources); KyberSwap when LI.FI has no route or its keyless quota is used up. */
  async function getQuote(who: Address): Promise<AggQuote> {
    const r = req(who);
    try {
      const x = await lifiQuote(r);
      checkBridgeQuote(x, r);
      return { via: "lifi", toolName: `${x.toolName} · LI.FI`, verified: VERIFIED.has(x.tool), toAmount: x.toAmount, toAmountMin: x.toAmountMin < x.toAmount ? x.toAmountMin : x.toAmount, feesUsd: x.feesUsd + x.gasUsd, spender: LIFI_DIAMONDS[RH]!.diamond, lifi: x };
    } catch (e1) {
      try {
        const k = await kyberRoute(from.address, to.address, amountRaw);
        if (k.routerAddress.toLowerCase() !== KYBER_ROUTER.toLowerCase()) throw new Error("unexpected contract");
        return { via: "kyber", toolName: `KyberSwap · ${k.exchanges.map(prettyId).join(", ")}`, verified: k.exchanges.length > 0 && k.exchanges.every((x) => VERIFIED_VENUES.has(x.toLowerCase())), toAmount: k.amountOut, toAmountMin: (k.amountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n, feesUsd: null, spender: KYBER_ROUTER, kyber: k };
      } catch {
        throw e1;
      }
    }
  }

  useEffect(() => {
    if (amountRaw <= 0n) return;
    setLoading(true);
    setErr(null);
    setQ(null);
    getQuote(user ?? PREVIEW)
      .then((x) => live.current && setQ(x))
      .catch((e) => live.current && setErr((e as Error).message.slice(0, 140)))
      .finally(() => live.current && setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from.address, to.address, amountRaw, user]);

  const onChain = w.chainId === RH;
  useEffect(() => {
    if (!w.provider || !user || !onChain) return;
    const p = w.provider;
    if (q) void p.request({ method: "eth_call", params: [{ to: from.address, data: allowanceData(user, q.spender) }, "latest"] }).then((r) => live.current && setAllow(BigInt(r as string)), () => undefined);
    void p.request({ method: "eth_call", params: [{ to: from.address, data: balanceData(user) }, "latest"] }).then((r) => live.current && setBal(BigInt(r as string)), () => undefined);
  }, [w.provider, user, onChain, from.address, step.k, q?.spender]);

  const out = q ? Number(formatUnits(q.toAmount, to.decimals)) : null;
  const inp = Number(formatUnits(amountRaw, from.decimals));
  const loss = out !== null && fromUsd && toUsd ? 1 - (out * toUsd) / (inp * fromUsd) : null;
  const verified = q?.verified ?? false;
  const tooCostly = loss !== null && loss > MAX;
  const busy = step.k === "wallet" || step.k === "pending";

  async function send(p: Eip1193, tx: { from: Address; to: Address; data: Hex; value: Hex; gas?: Hex }): Promise<Hex> {
    if ((await chainIdOf(p)) !== RH) throw new Error("wrong network");
    return (await p.request({ method: "eth_sendTransaction", params: [tx] })) as Hex;
  }
  const msg = (e: unknown) => {
    const k = errorKind(e);
    return k === "OTHER" ? t("swap.err.OTHER", { m: (e as Error).message.slice(0, 140) }) : t(`swap.err.${k}`);
  };

  async function approve() {
    if (!w.provider || !user) return;
    try {
      setStep({ k: "wallet", what: "approve" });
      if (!q) return;
      const hash = await send(w.provider, { from: user, to: from.address, data: approveData(q.spender, amountRaw), value: "0x0" });
      setStep({ k: "pending", what: "approve", hash });
      if (!(await waitReceipt(w.provider, hash))) throw new Error("approval failed");
      setStep({ k: "idle" });
    } catch (e) {
      setStep({ k: "error", msg: msg(e) });
    }
  }

  async function swap() {
    if (!w.provider || !user) return;
    try {
      // Re-quote for the connected address right before signing; build and check the exact transaction.
      const fresh = await getQuote(user);
      let tx: { from: Address; to: Address; data: Hex; value: Hex; gas?: Hex };
      let outNow: bigint;
      if (fresh.via === "lifi") {
        const lq = fresh.lifi!;
        tx = { from: lq.tx.from, to: lq.tx.to, data: lq.tx.data, value: lq.tx.value, ...(lq.tx.gas ? { gas: lq.tx.gas } : {}) };
        outNow = lq.toAmount;
      } else {
        const b = await kyberBuild(fresh.kyber!, user, SLIPPAGE_BPS);
        checkKyberTx(b, { user, tokenIn: from.address, tokenOut: to.address, amountIn: amountRaw });
        tx = { from: user, to: b.to, data: b.data, value: b.value };
        outNow = b.amountOut;
      }
      const o = Number(formatUnits(outNow, to.decimals));
      if (fromUsd && toUsd && 1 - (o * toUsd) / (inp * fromUsd) > MAX) throw new Error(t("agg.blocked", { x: pct((1 - (o * toUsd) / (inp * fromUsd)) * 100, 1) }));
      if (fresh.spender.toLowerCase() !== q?.spender.toLowerCase()) {
        // A different contract now: its approval must be checked again before sending.
        setQ(fresh);
        return setStep({ k: "idle" });
      }
      setQ(fresh);
      setStep({ k: "wallet", what: "swap" });
      const hash = await send(w.provider, tx);
      setStep({ k: "pending", what: "swap", hash });
      if (!(await waitReceipt(w.provider, hash))) return setStep({ k: "error", msg: t("swap.failed"), hash });
      setStep({ k: "done", hash });
    } catch (e) {
      setStep({ k: "error", msg: msg(e) });
    }
  }

  const needsApproval = allow !== null && allow < amountRaw;
  const insufficient = bal !== null && bal < amountRaw;
  let main: { label: string; onClick?: () => void; disabled?: boolean };
  if (!user) main = { label: t("shell.connect"), onClick: w.openPicker };
  else if (!onChain) main = { label: t("swap.switch"), onClick: () => w.provider && switchToRobinhood(w.provider).catch((e) => setStep({ k: "error", msg: msg(e) })) };
  else if (loading || !q) main = { label: loading ? t("bridge.finding") : t("bridge.noRoute"), disabled: true };
  else if (tooCostly) main = { label: t("agg.blocked", { x: pct(loss! * 100, 1) }), disabled: true };
  else if (insufficient) main = { label: t("swap.insufficient", { s: from.symbol }), disabled: true };
  else if (step.k === "wallet") main = { label: t("swap.confirmWallet"), disabled: true };
  else if (step.k === "pending") main = { label: step.what === "approve" ? t("swap.approving") : t("swap.swapping"), disabled: true };
  else if (step.k === "done") main = { label: t("swap.done"), disabled: true };
  else if (needsApproval) main = { label: t("swap.approve", { s: from.symbol }), onClick: () => void approve() };
  else main = { label: t("agg.swap", { a: from.symbol, b: to.symbol }), onClick: () => void swap(), disabled: !verified && !ack };

  const link = (h?: Hex) => {
    const u = h ? explorerTx(h) : null;
    return u ? (
      <a href={u} target="_blank" rel="noopener noreferrer">
        {t("swap.viewTx")}
      </a>
    ) : null;
  };

  return (
    <div className="agg">
      <div className="kv">
        <span className="muted">{t("swap.route")}</span>
        <span>
          {q ? (
            <>
              <span className="route-ok" title={q.toolName}>
                {t("swap.routeFound")}
              </span>{" "}
              <span className={`src-badge ${verified ? "ok" : "warn"}`}>{verified ? t("agg.verified") : t("agg.unverified")}</span>
            </>
          ) : loading ? (
            <span className="route-wait">{t("swap.routeSearching")}</span>
          ) : (
            "·"
          )}
        </span>
        <span className="muted">{t("bridge.receive")}</span>
        <strong className="num">{q ? `≈ ${amount(formatUnits(q.toAmount, to.decimals), 6)} ${to.symbol}` : "·"}</strong>
        <span className="muted">{t("swap.minReceived")}</span>
        <span className="num">{q ? `${amount(formatUnits(q.toAmountMin, to.decimals), 6)} ${to.symbol}` : "·"}</span>
        <span className="muted">{t("agg.vsOracle")}</span>
        <span className={`num ${loss === null ? "" : loss <= GOOD ? "up" : loss <= MAX ? "warnc" : "down"}`}>
          {loss === null ? "·" : `${loss > 0 ? "−" : "+"}${pct(Math.abs(loss) * 100, 2)}`} {loss !== null && <span className="muted small">({t(loss <= GOOD ? "agg.good" : loss <= MAX ? "agg.ok" : "agg.expensive")})</span>}
        </span>
        {q && q.feesUsd !== null && (
          <>
            <span className="muted">{t("bridge.fees")}</span>
            <span className="num">{usd(q.feesUsd.toFixed(2))}</span>
          </>
        )}
      </div>
      {err && !q && <div className="muted small">{err}</div>}
      {q && !verified && !tooCostly && (
        <label className="notice warn small" style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{t("agg.ackUnverified", { s: q.toolName })}</span>
        </label>
      )}
      <button className="btn primary big" onClick={main.onClick} disabled={main.disabled || busy}>
        {main.label}
      </button>
      {step.k === "pending" && <div className="small muted">{link(step.hash)}</div>}
      {step.k === "done" && (
        <div className="notice ok small" role="status">
          {t("swap.done")} {link(step.hash)}
        </div>
      )}
      {step.k === "error" && (
        <div className="notice bad small" role="alert">
          {step.msg} {link(step.hash)}
        </div>
      )}
      <div className="faint small">{t("agg.note")}</div>
    </div>
  );
}

/** Asset page: buy or sell a Stock Token against USDG through the aggregator. */
export function AggregatorPanel({ asset }: { asset: Tok }) {
  const { t } = useI18n();
  const agg = useAggregator();
  const row = agg?.get(asset.key) ?? null;
  const usdg: Tok = { key: "4663:0x5fc5360d0400a0fd4f2af552add042d716f1d168", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 };
  const [dir, setDir] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("100");
  const [go, setGo] = useState(false);
  const from = dir === "buy" ? usdg : asset;
  const to = dir === "buy" ? asset : usdg;
  let raw: bigint | null = null;
  try {
    raw = /^\d+(\.\d+)?$/.test(amt) && Number(amt) > 0 ? parseUnits(amt, from.decimals) : null;
  } catch {
    raw = null;
  }
  return (
    <div className="panel pad agg-panel">
      <div className="agg-head">
        <h3>{t("agg.title")}</h3>
        {row && row.cls !== "NO_ROUTE" && (
          <span className={`src-badge ${row.cls === "GOOD" ? "ok" : row.cls === "OK" ? "warn" : "bad"}`}>
            {t("agg.scan", { s: row.toolName ? prettyId(row.toolName) : "·", x: row.loss !== null ? pct(row.loss * 100, 2) : "·" })}
          </span>
        )}
        {row?.cls === "NO_ROUTE" && <span className="src-badge bad">{t("agg.noRouteScan")}</span>}
      </div>
      <div className="row" style={{ gap: 10 }}>
        <div className="seg" role="radiogroup" aria-label={t("agg.title")}>
          {(["buy", "sell"] as const).map((d) => (
            <button key={d} role="radio" aria-checked={dir === d} className={dir === d ? "on" : undefined} onClick={() => (setDir(d), setAmt(d === "buy" ? "100" : "1"), setGo(false))}>
              {t(d === "buy" ? "agg.buy" : "agg.sell", { s: asset.symbol })}
            </button>
          ))}
        </div>
        <label className="agg-amt">
          <span className="sr-only">{t("bridge.amount")}</span>
          <input className="input num" inputMode="decimal" value={amt} onChange={(e) => (setAmt(e.target.value.replace(",", ".").replace(/[^0-9.]/g, "")), setGo(false))} aria-label={t("bridge.amount")} />
          <span className="muted small">{from.symbol}</span>
        </label>
        {!go && (
          <button className="btn primary" disabled={!raw} onClick={() => setGo(true)}>
            {t("quick.getQuote")}
          </button>
        )}
      </div>
      {go && raw && <AggregatorSwap key={`${dir}-${amt}`} from={from} to={to} amountRaw={raw} />}
    </div>
  );
}
