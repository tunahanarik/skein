/**
 * KyberSwap aggregator on Robinhood Chain (keyless API, https://aggregator-api.kyberswap.com/robinhood).
 * Used for coverage scans (generous rate limit) and as the execution fallback when LI.FI's keyless
 * quota is exhausted.
 *
 * Every built transaction is decoded and checked before it reaches the wallet (`checkKyberTx`):
 * target = the pinned MetaAggregationRouterV2 (same address on every chain, code verified on 4663),
 * swap(desc) with the requested tokens and amount, output to the user, a minimum output, and no fee
 * receivers.
 */
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";

export const KYBER_API = "https://aggregator-api.kyberswap.com/robinhood/api/v1";
export const KYBER_ROUTER: Address = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const CLIENT_ID = "skein";

export const kyberRouterAbi = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
]);

export interface KyberRoute {
  amountOut: bigint;
  exchanges: string[];
  routerAddress: Address;
  /** Opaque route summary, passed back to /route/build. */
  summary: unknown;
}

const clean = (s: unknown, n = 40) => (typeof s === "string" ? s.replace(/[^\w .-]/g, "").slice(0, n) : "");

export async function kyberRoute(tokenIn: Address, tokenOut: Address, amountIn: bigint, f: typeof fetch = fetch, signal?: AbortSignal): Promise<KyberRoute> {
  const r = await f(`${KYBER_API}/routes?tokenIn=${tokenIn}&tokenOut=${tokenOut}&amountIn=${amountIn}`, { headers: { "x-client-id": CLIENT_ID, Accept: "application/json" }, signal: signal ?? AbortSignal.timeout(12_000) });
  const j = (await r.json().catch(() => null)) as { code?: number; message?: string; data?: { routeSummary?: Record<string, unknown>; routerAddress?: string } } | null;
  const rs = j?.data?.routeSummary;
  if (!r.ok || j?.code !== 0 || !rs) throw new Error(clean(j?.message, 120) || `KyberSwap ${r.status}`);
  const out = String(rs.amountOut ?? "");
  if (!/^\d{1,78}$/.test(out)) throw new Error("bad amount");
  const route = Array.isArray(rs.route) ? (rs.route as { exchange?: unknown }[][]) : [];
  return {
    amountOut: BigInt(out),
    exchanges: [...new Set(route.flat().map((x) => clean(x.exchange, 30)).filter(Boolean))],
    routerAddress: getAddress(String(j!.data!.routerAddress ?? KYBER_ROUTER)),
    summary: rs,
  };
}

export async function kyberBuild(route: KyberRoute, user: Address, slippageBps: number, f: typeof fetch = fetch): Promise<{ to: Address; data: Hex; value: Hex; amountOut: bigint }> {
  const r = await f(`${KYBER_API}/route/build`, {
    method: "POST",
    headers: { "x-client-id": CLIENT_ID, "content-type": "application/json" },
    body: JSON.stringify({ routeSummary: route.summary, sender: user, recipient: user, slippageTolerance: slippageBps }),
    signal: AbortSignal.timeout(12_000),
  });
  const j = (await r.json().catch(() => null)) as { code?: number; message?: string; data?: Record<string, unknown> } | null;
  const d = j?.data;
  if (!r.ok || j?.code !== 0 || !d || typeof d.data !== "string" || !/^0x[0-9a-fA-F]+$/.test(d.data)) throw new Error(clean(j?.message, 120) || `KyberSwap build ${r.status}`);
  const value = BigInt(String(d.transactionValue ?? "0") || "0");
  return { to: getAddress(String(d.routerAddress)), data: d.data as Hex, value: `0x${value.toString(16)}` as Hex, amountOut: BigInt(String(d.amountOut ?? "0")) };
}

/** Refuses anything but swap(desc) on the pinned router for exactly this request. */
export function checkKyberTx(tx: { to: Address; data: Hex; value: Hex }, req: { user: Address; tokenIn: Address; tokenOut: Address; amountIn: bigint }): { minOut: bigint } {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(tx.to, KYBER_ROUTER)) throw new Error("unexpected contract");
  if (BigInt(tx.value) !== 0n) throw new Error("unexpected value");
  const d = decodeFunctionData({ abi: kyberRouterAbi, data: tx.data });
  if (d.functionName !== "swap") throw new Error("unexpected call");
  const desc = (d.args[0] as { desc: { srcToken: Address; dstToken: Address; feeReceivers: readonly Address[]; feeAmounts: readonly bigint[]; dstReceiver: Address; amount: bigint; minReturnAmount: bigint } }).desc;
  if (!eq(desc.srcToken, req.tokenIn) || !eq(desc.dstToken, req.tokenOut)) throw new Error("token mismatch");
  if (desc.amount !== req.amountIn) throw new Error("amount mismatch");
  if (!eq(desc.dstReceiver, req.user)) throw new Error("recipient is not the user");
  if (desc.minReturnAmount <= 0n) throw new Error("no minimum output");
  if (desc.feeReceivers.length || desc.feeAmounts.some((x) => x > 0n)) throw new Error("unexpected fee");
  return { minOut: desc.minReturnAmount };
}
