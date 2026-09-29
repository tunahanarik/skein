/**
 * Cross-chain bridging through LI.FI (li.quest), the aggregator Robinhood's chain docs list next to
 * the canonical bridge. LI.FI compares bridges (Relay, Across, Stargate, …) and returns one
 * transaction to its own contract (the "diamond") on the source chain.
 *
 * The browser calls li.quest directly (CSP connect-src allows exactly that host), so the wallet
 * address — required to build the transaction — never passes through our server. Every response is
 * untrusted: `checkBridgeQuote` accepts a transaction only if it matches what the user asked for and
 * goes to the pinned diamond (diamonds.ts), before it is handed to the wallet.
 *
 * Sources are the EVM chains with a pinned diamond (the only place a transaction is signed).
 * Destinations are every LI.FI mainnet, including Solana, Bitcoin and Sui: those need a recipient
 * address on that chain, which the user types and `validRecipient` checks (format and checksum);
 * EVM destinations always deliver to the user's own address.
 */
import { encodeFunctionData, getAddress, parseAbi, sha256, type Address, type Hex } from "viem";
import { LIFI_DIAMONDS } from "./diamonds.js";

export const LIFI_API = "https://li.quest/v1";
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";
/** LI.FI's placeholder for the native coin on some chains. */
const NATIVE_ALT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const INTEGRATOR = "hoodmap";

export type ChainKind = "EVM" | "SVM" | "UTXO" | "MVM";
/** LI.FI ids of the non-EVM mainnets (everything else is EVM). */
const NON_EVM: Record<number, ChainKind> = { 1151111081099710: "SVM", 20000000000001: "UTXO", 9270000000000000: "MVM" };
export const kindOf = (chainId: number): ChainKind => NON_EVM[chainId] ?? "EVM";

export interface Chain {
  id: number;
  name: string;
  coin: string;
  kind: ChainKind;
  /** A bridge can start here: EVM with a pinned diamond. Other chains are destinations only. */
  source: boolean;
  /** Remote logo URL (shown through /api/img, which allowlists hosts), or null. */
  logo: string | null;
  addParams: { chainId: Hex; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrls: string[] } | null;
}

export interface Token {
  chainId: number;
  /** EVM: checksummed 0x address (NATIVE for the coin). Solana: base58 mint. Bitcoin: "bitcoin". Sui: coin type. */
  address: string;
  /** The chain's own coin (ETH, SOL, BTC, SUI…). */
  native: boolean;
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
  /** On the destination chain: an EVM address, or a Solana / Bitcoin / Sui address. */
  toAddress: string;
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
/** Token address formats LI.FI uses per chain kind. */
const TOKEN_ADDR: Record<ChainKind, RegExp> = {
  EVM: /^0x[0-9a-fA-F]{40}$/,
  SVM: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  UTXO: /^bitcoin$/,
  MVM: /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][A-Za-z0-9_]{0,63}::[A-Za-z_][A-Za-z0-9_]{0,63}$/,
};
const NATIVE_OF: Record<Exclude<ChainKind, "EVM">, string> = { SVM: "11111111111111111111111111111111", UTXO: "bitcoin", MVM: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI" };
/** Same address on a chain of this kind: hex is case-insensitive, base58 is not. */
function sameAddr(kind: ChainKind, a: string, b: string): boolean {
  return kind === "EVM" || kind === "MVM" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 255n));
  for (let i = 0; i < s.length && s[i] === "1"; i++) out.unshift(0);
  return Uint8Array.from(out);
}
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
/** Bitcoin mainnet segwit address (BIP-173 bech32 for v0, BIP-350 bech32m for v1+), checksum verified. */
function bech32Ok(addr: string): boolean {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return false;
  const s = addr.toLowerCase();
  if (!s.startsWith("bc1") || s.length > 90) return false;
  const data = [...s.slice(3)].map((c) => BECH32.indexOf(c));
  if (data.some((d) => d < 0) || data.length < 7) return false;
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  // hrp "bc" expanded: high bits (3, 3), a zero, low bits (2, 3).
  for (const v of [3, 3, 0, 2, 3, ...data]) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= G[i]!;
  }
  chk >>>= 0;
  const ver = data[0]!;
  if (ver === 0) return chk === 1 && (s.length === 42 || s.length === 62);
  return ver <= 16 && chk === 0x2bc830a3 && s.length === 62;
}
/** Bitcoin mainnet legacy address (P2PKH "1…", P2SH "3…"), base58check verified. */
function base58checkOk(addr: string): boolean {
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(addr)) return false;
  const b = base58(addr);
  if (!b || b.length !== 25 || (b[0] !== 0x00 && b[0] !== 0x05)) return false;
  const sum = sha256(sha256(b.slice(0, 21), "bytes"), "bytes");
  return [0, 1, 2, 3].every((i) => sum[i] === b[21 + i]);
}
/**
 * A recipient the user typed for a destination chain. Solana: base58 of exactly 32 bytes.
 * Bitcoin: checksummed mainnet address. Sui: 0x + 64 hex (Sui addresses carry no checksum).
 * EVM: a 0x address (EVM destinations still deliver only to the user's own address).
 */
export function validRecipient(kind: ChainKind, addr: string): boolean {
  if (addr.length > 100) return false;
  if (kind === "EVM") return isAddr(addr);
  if (kind === "SVM") return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) && base58(addr)?.length === 32;
  if (kind === "UTXO") return bech32Ok(addr) || base58checkOk(addr);
  return /^0x[0-9a-fA-F]{64}$/.test(addr);
}
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

/**
 * Chain and token lists change rarely: kept in memory for LISTS_TTL_MS so reopening the bridge is
 * instant and the keyless quota goes to quotes. A failed load is not kept. Quotes are never cached.
 */
const LISTS_TTL_MS = 10 * 60_000;
const lists = new Map<string, { at: number; p: Promise<unknown> }>();
function cachedList<T>(key: string, load: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let e = lists.get(key);
  if (!e || Date.now() - e.at > LISTS_TTL_MS) {
    const p = load();
    e = { at: Date.now(), p };
    lists.set(key, e);
    p.catch(() => lists.get(key)?.p === p && lists.delete(key));
  }
  const p = e.p as Promise<T>;
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
/** Test hook: forget cached chain and token lists. */
export function clearListCache(): void {
  lists.clear();
}

/** Every LI.FI mainnet: EVM chains with a pinned diamond as sources, all of them as destinations. */
export function chains(signal?: AbortSignal): Promise<Chain[]> {
  return cachedList("chains", loadChains, signal);
}
async function loadChains(): Promise<Chain[]> {
  const r = await get<{ chains: Record<string, unknown>[] }>("/chains", { chainTypes: "EVM,SVM,UTXO,MVM" });
  const out: Chain[] = [];
  for (const c of r.chains) {
    const id = Number(c.id);
    const kind = kindOf(id);
    if (!(Number.isSafeInteger(id) || NON_EVM[id]) || id <= 0 || c.mainnet !== true || c.chainType !== kind) continue;
    const pin = LIFI_DIAMONDS[id];
    if (!pin) {
      const name = cleanText(c.name, 30);
      const coin = cleanText((c.nativeToken as Record<string, unknown> | undefined)?.symbol, 10);
      if (name) out.push({ id, name, coin: coin || "?", kind, source: false, logo: httpsUrl(c.logoURI), addParams: null });
      continue;
    }
    const mm = c.metamask as Record<string, unknown> | undefined;
    const rpc = Array.isArray(mm?.rpcUrls) ? (mm!.rpcUrls as unknown[]).filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 3) : [];
    const exp = Array.isArray(mm?.blockExplorerUrls) ? (mm!.blockExplorerUrls as unknown[]).filter((u): u is string => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 2) : [];
    const nc = mm?.nativeCurrency as Record<string, unknown> | undefined;
    out.push({
      id,
      name: pin.name,
      coin: pin.coin,
      kind,
      source: kind === "EVM",
      logo: httpsUrl(c.logoURI),
      addParams: rpc.length && nc ? { chainId: `0x${id.toString(16)}`, chainName: pin.name, nativeCurrency: { name: cleanText(nc.name, 20) || pin.coin, symbol: cleanText(nc.symbol, 10) || pin.coin, decimals: Number(nc.decimals) || 18 }, rpcUrls: rpc, blockExplorerUrls: exp } : null,
    });
  }
  return out;
}

export function parseToken(t: Record<string, unknown>): Token | null {
  const chainId = Number(t.chainId);
  const kind = kindOf(chainId);
  if (typeof t.address !== "string" || !TOKEN_ADDR[kind].test(t.address)) return null;
  const decimals = Number(t.decimals);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const address = kind === "EVM" ? (isNative(t.address) ? NATIVE : getAddress(t.address)) : t.address;
  return {
    chainId,
    address,
    native: kind === "EVM" ? address === NATIVE : address === NATIVE_OF[kind],
    symbol: cleanText(t.symbol, 16) || "?",
    name: cleanText(t.name, 40),
    decimals,
    priceUSD: num(t.priceUSD),
    verified: t.verificationStatus === "verified",
    logo: httpsUrl(t.logoURI),
  };
}

export function tokens(chainId: number, signal?: AbortSignal): Promise<Token[]> {
  return cachedList(`tokens:${chainId}`, async () => {
    const r = await get<{ tokens: Record<string, Record<string, unknown>[]> }>("/tokens", { chains: String(chainId) });
    return (r.tokens[String(chainId)] ?? []).map(parseToken).filter((t): t is Token => !!t && t.chainId === chainId);
  }, signal);
}

export interface QuoteRequest {
  fromChainId: number;
  toChainId: number;
  fromToken: Address;
  toToken: string;
  fromAmount: bigint;
  user: Address;
  /** Receives on the destination chain: the user's own address on EVM, else the address they typed. */
  recipient: string;
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
      toAddress: req.recipient,
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
  const toKind = kindOf(Number(a.toChainId));
  if (typeof a.toAddress !== "string" || !validRecipient(toKind, a.toAddress)) throw new Error("LI.FI returned an unusable quote");
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
    toAddress: toKind === "EVM" ? getAddress(a.toAddress) : a.toAddress,
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
 * The quote must be exactly what the user asked for, from the user's own address to the recipient
 * (the user's own address on an EVM destination; a checked address on Solana, Bitcoin or Sui), and its
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
  const toKind = kindOf(req.toChainId);
  if (!validRecipient(toKind, req.recipient) || (toKind === "EVM" && !eq(req.recipient, req.user))) throw new Error("bad recipient");
  if (!eq(q.fromToken.address, req.fromToken) || !sameAddr(toKind, q.toToken.address, req.toToken)) throw new Error("token mismatch");
  if (q.fromAmount !== req.fromAmount) throw new Error("amount mismatch");
  if (!eq(q.fromAddress, req.user) || !sameAddr(toKind, q.toAddress, req.recipient) || !eq(q.tx.from, req.user)) throw new Error("address mismatch");
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
