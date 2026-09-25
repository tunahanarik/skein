/**
 * Chain calls through the user's wallet (EIP-1193). Reads use eth_call on the wallet's own RPC,
 * so this page never contacts a third-party node (CSP connect-src stays 'self').
 */
import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import type { Eip1193 } from "../wallet";
import { ADD_CHAIN_PARAMS, CHAIN_ID, CHAIN_ID_HEX, checkTx, erc20Abi, quoteCall, quoterAbi, SWAP_ROUTER, type SwapRoute, type Tx } from "./uniswap";

export async function chainIdOf(p: Eip1193): Promise<number> {
  return Number(await p.request({ method: "eth_chainId" }));
}

/** Asks the wallet to switch to Robinhood Chain, adding it first when the wallet does not know it. */
export async function switchToRobinhood(p: Eip1193): Promise<void> {
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN_ID_HEX }] });
  } catch (e) {
    if ((e as { code?: number }).code !== 4902) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [ADD_CHAIN_PARAMS] });
  }
  if ((await chainIdOf(p)) !== CHAIN_ID) throw new Error("wrong network");
}

async function call(p: Eip1193, to: Address, data: Hex, from?: Address): Promise<Hex> {
  return (await p.request({ method: "eth_call", params: [{ to, data, ...(from ? { from } : {}) }, "latest"] })) as Hex;
}

export async function balanceOf(p: Eip1193, token: Address, owner: Address): Promise<bigint> {
  const r = await call(p, token, encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [owner] }));
  return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data: r });
}

export async function allowance(p: Eip1193, token: Address, owner: Address): Promise<bigint> {
  const r = await call(p, token, encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, SWAP_ROUTER] }));
  return decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: r });
}

/** Fresh output for the exact route and amount from Uniswap's QuoterV2, at the latest block. */
export async function freshQuote(p: Eip1193, route: SwapRoute, amountIn: bigint): Promise<bigint> {
  const q = quoteCall(route, amountIn);
  const r = await call(p, q.to, q.data);
  return decodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactInput", data: r })[0];
}

/** eth_call dry run of the exact transaction; throws with the revert reason when it would fail. */
export async function simulate(p: Eip1193, tx: Tx): Promise<void> {
  await call(p, tx.to, tx.data, tx.from);
}

/** Checks the transaction shape, then hands it to the wallet, which shows it to the user to sign. */
export async function send(p: Eip1193, tx: Tx, ctx: { user: Address; route: SwapRoute }): Promise<Hex> {
  checkTx(tx, ctx);
  if ((await chainIdOf(p)) !== CHAIN_ID) throw new Error("wrong network");
  return (await p.request({ method: "eth_sendTransaction", params: [tx] })) as Hex;
}

/** Waits for the receipt (polling the wallet's RPC); true when the transaction succeeded. */
export async function waitReceipt(p: Eip1193, hash: Hex, timeoutMs = 180_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = (await p.request({ method: "eth_getTransactionReceipt", params: [hash] })) as { status?: string } | null;
    if (r?.status) return r.status === "0x1";
    await new Promise((res) => setTimeout(res, 1500));
  }
  throw new Error("timeout");
}

/** Short, user-facing kind of a wallet/RPC error. */
export function errorKind(e: unknown): "REJECTED" | "WRONG_NETWORK" | "REVERT" | "TIMEOUT" | "OTHER" {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001 || /user (rejected|denied)/i.test(err?.message ?? "")) return "REJECTED";
  if (/wrong network/.test(err?.message ?? "")) return "WRONG_NETWORK";
  if (/timeout/.test(err?.message ?? "")) return "TIMEOUT";
  if (err?.code === 3 || /revert|execution reverted|too little received/i.test(err?.message ?? "")) return "REVERT";
  return "OTHER";
}
