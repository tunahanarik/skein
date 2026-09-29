/**
 * Cross-chain bridging through LI.FI (li.quest), the aggregator Robinhood's chain docs list next to
 * the canonical bridge. LI.FI compares bridges (Relay, Across, Stargate, …) and returns one
 * transaction to its own contract (the "diamond") on the source chain.
 *
 * The browser calls li.quest directly (CSP connect-src allows exactly that host), so the wallet
 * address — required to build the transaction — never passes through our server. Every response is
 * untrusted: `checkBridgeQuote` accepts a transaction only if it matches what the user asked for and
 * goes to the pinned diamond (diamonds.ts), before it is handed to the wallet.
 */
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { LIFI_DIAMONDS } from "./diamonds.js";

export const LIFI_API = "https://li.quest/v1";
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
/** LI.FI's placeholder for the native coin on some chains. */
const NATIVE_ALT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const INTEGRATOR = "hoodmap";

export interface Chain {
  id: number;
  name: string;
  coin: string;
  /** Remote logo URL (shown through /api/img, which allowlists hosts), or null. */
  logo: string | null;
  addParams: { chainId: Hex; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] } | null;
}

export interface Token {
  chainId: number;
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  priceUSD: number | null;
  verified: boolean;
  /** Remote logo URL (shown through /api/img), or null. */
  logo: string | null;
}

export interface Quote {
  tool: string;
  toolName: string;
  fromChainId: number;
  toChainId: number;
  fromToken: Token;
  toToken: Token;
  fromAmount: bigint;
  toAmount: bigint;
  toAmountMin: bigint;
  fromAddress: Address;
  toAddress: Address;
  approvalAddress: Address | null;
  durationS: number | null;
  feesUsd: number;
  gasUsd: number;
  /** Fees LI.FI says are NOT included in the amount and are paid in the native coin (sent as value). */
  extraNativeFee: bigint;
  fromAmountUsd: number | null;
  toAmountUsd: number | null;
  tx: { from: Address; to: Address; data: Hex; value: Hex; chainId: number; gas?: Hex };
}

export type BridgeStatus = "PENDING" | "DONE" | "FAILED" | "NOT_FOUND" | "INVALID";

/** External text: one line, no control or bidi characters, bounded. */
export const cleanText = (s: unknown, max = 40): string => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, max) : "");
const httpsUrl = (u: unknown): string | null => (typeof u === "string" && /^https:\/\/[^\s"'<>]{1,580}$/.test(u) ? u : null);
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const isNative = (a: string) => a.toLowerCase() === NATIVE || a.toLowerCase() === NATIVE_ALT;
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const big = (v: unknown): bigint => {
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) throw new Error("bad amount");
  return BigInt(v);
};

async function get<T>(path: string, q: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const url = `${LIFI_API}${path}?${new URLSearchParams(q).toString()}`;
  const r = await fetch(url, { signal: signal ?? null, credentials: "omit", referrerPolicy: "no-referrer", headers: { Accept: "application/json" } });
  const body = (await r.json().catch(() => null)) as { message?: string } | null;
  if (!r.ok) throw new Error(cleanText(body?.message, 200) || `LI.FI ${r.status}`);
  return body as T;
}

/** EVM mainnets that LI.FI supports AND whose diamond is pinned. */
export async function chains(signal?: AbortSignal): Promise<Chain[]> {
  const r = await get<{ chains: Record<string, unknown>[] }>("/chains", { chainTypes: "EVM" }, signal);
  const out: Chain[] = [];
  for (const c of r.chains) {
    const id = Number(c.id);
    const pin = LIFI_DIAMONDS[id];
    if (!pin || c.mainnet !== true) continue;
    const mm = c.metamask as Record<string, unknown> | undefined;
    const rpc = Array.isArray(mm?.rpcUrls) ? (mm!.rpcUrls as unknown[]).filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 3) : [];
    const exp = Array.isArray(mm?.blockExplorerUrls) ? (mm!.blockExplorerUrls as unknown[]).filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 2) : [];
    const nc = mm?.nativeCurrency as Record<string, unknown> | undefined;
    out.push({
      id,
      name: pin.name,
      coin: pin.coin,
      logo: httpsUrl(c.logoURI),
      addParams: rpc.length && nc ? { chainId: `0x${id.toString(16)}`, chainName: pin.name, nativeCurrency: { name: cleanText(nc.name, 20) || pin.coin, symbol: cleanText(nc.symbol, 10) || pin.coin, decimals: Number(nc.decimals) || 18 }, rpcUrls: rpc, blockExplorerUrls: exp } : null,
    });
  }
  return out;
}

export function parseToken(t: Record<string, unknown>): Token | null {
  if (!isAddr(t.address)) return null;
  const decimals = Number(t.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  return {
    chainId: Number(t.chainId),
    address: isNative(t.address) ? NATIVE : getAddress(t.address),
    symbol: cleanText(t.symbol, 16) || "?",
    name: cleanText(t.name, 40),
    decimals,
    priceUSD: num(t.priceUSD),
    verified: t.verificationStatus === "verified",
    logo: httpsUrl(t.logoURI),
  };
}

export async function tokens(chainId: number, signal?: AbortSignal): Promise<Token[]> {
  const r = await get<{ tokens: Record<string, Record<string, unknown>[]> }>("/tokens", { chains: String(chainId) }, signal);
  return (r.tokens[String(chainId)] ?? []).map(parseToken).filter((t): t is Token => !!t && t.chainId === chainId);
}

export interface QuoteRequest {
  fromChainId: number;
  toChainId: number;
  fromToken: Address;
  toToken: Address;
  fromAmount: bigint;
  user: Address;
  slippage: number; // fraction, e.g. 0.005
  order: "CHEAPEST" | "FASTEST";
}

export async function quote(req: QuoteRequest, signal?: AbortSignal): Promise<Quote> {
  const r = await get<Record<string, unknown>>(
    "/quote",
    {
      fromChain: String(req.fromChainId),
      toChain: String(req.toChainId),
      fromToken: req.fromToken,
      toToken: req.toToken,
      fromAmount: req.fromAmount.toString(),
      fromAddress: req.user,
      toAddress: req.user,
      slippage: String(req.slippage),
      order: req.order,
      integrator: INTEGRATOR,
      allowExchanges: "all",
    },
    signal,
  );
  const a = r.action as Record<string, unknown>;
  const e = r.estimate as Record<string, unknown>;
  const tx = r.transactionRequest as Record<string, unknown>;
  const ft = parseToken(a.fromToken as Record<string, unknown>);
  const tt = parseToken(a.toToken as Record<string, unknown>);
  if (!ft || !tt || !tx || !isAddr(tx.to) || !isAddr(tx.from) || typeof tx.data !== "string" || !/^0x[0-9a-fA-F]*$/.test(tx.data)) throw new Error("LI.FI returned an unusable quote");
  const sumUsd = (xs: unknown, onlyIncluded?: boolean) => (Array.isArray(xs) ? xs : []).reduce((s: number, f: Record<string, unknown>) => s + (onlyIncluded === undefined || f.included === onlyIncluded ? (num(f.amountUSD) ?? 0) : 0), 0);
  const toolDetails = r.toolDetails as Record<string, unknown> | undefined;
  const extraNativeFee = (Array.isArray(e.feeCosts) ? (e.feeCosts as Record<string, unknown>[]) : []).reduce((s, f) => {
    const tok = f.token as Record<string, unknown> | undefined;
    return f.included === false && typeof tok?.address === "string" && isNative(tok.address) && typeof f.amount === "string" && /^\d{1,78}$/.test(f.amount) ? s + BigInt(f.amount) : s;
  }, 0n);
  return {
    tool: cleanText(r.tool, 30),
    toolName: cleanText(toolDetails?.name, 30) || cleanText(r.tool, 30),
    fromChainId: Number(a.fromChainId),
    toChainId: Number(a.toChainId),
    fromToken: ft,
    toToken: tt,
    fromAmount: big(a.fromAmount),
    toAmount: big(e.toAmount),
    toAmountMin: big(e.toAmountMin),
    fromAddress: getAddress(String(a.fromAddress)),
    toAddress: getAddress(String(a.toAddress)),
    approvalAddress: isAddr(e.approvalAddress) ? getAddress(e.approvalAddress) : null,
    durationS: num(e.executionDuration),
    feesUsd: sumUsd(e.feeCosts),
    gasUsd: sumUsd(e.gasCosts),
    extraNativeFee,
    fromAmountUsd: num(e.fromAmountUSD),
    toAmountUsd: num(e.toAmountUSD),
    tx: {
      from: getAddress(tx.from),
      to: getAddress(tx.to),
      data: tx.data as Hex,
      value: typeof tx.value === "string" && /^0x[0-9a-fA-F]+$/.test(tx.value) ? (tx.value as Hex) : "0x0",
      chainId: Number(tx.chainId),
      ...(typeof tx.gasLimit === "string" && /^0x[0-9a-fA-F]+$/.test(tx.gasLimit) ? { gas: tx.gasLimit as Hex } : {}),
    },
  };
}

/**
 * The quote must be exactly what the user asked for, from and to the user's own address, and its
 * transaction must go to the pinned LI.FI diamond of the source chain. The ETH value must be the
 * amount itself for native input, plus at most the fees the quote declares as paid on top in the
 * native coin (`extraNativeFee`, shown to the user). Throws a short reason otherwise.
 */
export function checkBridgeQuote(q: Quote, req: QuoteRequest): void {
  const maxFeeValue = q.extraNativeFee;
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const pin = LIFI_DIAMONDS[req.fromChainId];
  if (!pin) throw new Error("source chain not supported");
  if (q.fromChainId !== req.fromChainId || q.toChainId !== req.toChainId || q.tx.chainId !== req.fromChainId) throw new Error("chain mismatch");
  if (!eq(q.fromToken.address, req.fromToken) || !eq(q.toToken.address, req.toToken)) throw new Error("token mismatch");
  if (q.fromAmount !== req.fromAmount) throw new Error("amount mismatch");
  if (!eq(q.fromAddress, req.user) || !eq(q.toAddress, req.user) || !eq(q.tx.from, req.user)) throw new Error("address mismatch");
  if (!eq(q.tx.to, pin.diamond)) throw new Error("unexpected contract");
  if (!isNative(req.fromToken) && (!q.approvalAddress || !eq(q.approvalAddress, pin.diamond))) throw new Error("unexpected spender");
  if (q.toAmountMin <= 0n || q.toAmount <= 0n) throw new Error("no minimum output");
  const value = BigInt(q.tx.value);
  if (isNative(req.fromToken) ? value < req.fromAmount || value - req.fromAmount > maxFeeValue : value > maxFeeValue) throw new Error("unexpected value");
}

const erc20 = parseAbi(["function approve(address spender, uint256 amount) returns (bool)", "function allowance(address owner, address spender) view returns (uint256)", "function balanceOf(address owner) view returns (uint256)"]);

export function approveData(spender: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20, functionName: "approve", args: [spender, amount] });
}
export function allowanceData(owner: Address, spender: Address): Hex {
  return encodeFunctionData({ abi: erc20, functionName: "allowance", args: [owner, spender] });
}
export function balanceData(owner: Address): Hex {
  return encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [owner] });
}

export async function status(q: { txHash: Hex; fromChainId: number; toChainId: number; tool: string }, signal?: AbortSignal): Promise<{ status: BridgeStatus; substatus: string; receivingTx: Hex | null }> {
  const r = await get<Record<string, unknown>>("/status", { txHash: q.txHash, fromChain: String(q.fromChainId), toChain: String(q.toChainId), bridge: q.tool }, signal).catch((e: Error) => {
    if (/not found|404/i.test(e.message)) return { status: "NOT_FOUND" } as Record<string, unknown>;
    throw e;
  });
  const s = ["PENDING", "DONE", "FAILED", "NOT_FOUND", "INVALID"].includes(r.status as string) ? (r.status as BridgeStatus) : "PENDING";
  const recv = (r.receiving as Record<string, unknown> | undefined)?.txHash;
  return { status: s, substatus: cleanText(r.substatus, 40), receivingTx: typeof recv === "string" && /^0x[0-9a-fA-F]{64}$/.test(recv) ? (recv as Hex) : null };
}

/** Explorer link for a tx on LI.FI's scan (covers every chain). */
export function scanUrl(hash: string): string | null {
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? `https://scan.li.fi/tx/${hash}` : null;
}
