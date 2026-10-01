/**
 * Uniswap v3 swap transactions, built in the browser and signed in the user's own wallet.
 * The server stays read-only; nothing here holds keys or sends anything by itself.
 *
 * Only one shape of transaction can leave this module (see `checkTx`):
 *   - ERC-20 approve(SWAP_ROUTER, exact amount) on the route's input token, and
 *   - SwapRouter02.multicall(deadline, [exactInput(path, recipient = user, amountIn, minOut)]).
 * Addresses are Uniswap's official Robinhood Chain deployments (github.com/Uniswap/contracts,
 * deployments/json/4663.json), re-checked on-chain: SwapRouter02.factory() is the v3 factory and
 * WETH9() is the chain's WETH (scripts/validate-swap.ts). Asserted equal to src/ by tests.
 */
import { decodeFunctionData, encodeFunctionData, encodePacked, getAddress, parseAbi, type Address, type Hex } from "viem";

export const CHAIN_ID = 4663;
export const CHAIN_ID_HEX = "0x1237";
export const SWAP_ROUTER: Address = "0xcaf681a66d020601342297493863e78c959e5cb2";
export const QUOTER_V2: Address = "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7";
/** Fee tiers enabled on the v3 factory (ppm). */
export const FEE_TIERS = [100, 500, 3000, 10000] as const;

/** wallet_addEthereumChain parameters (src/config/chains.ts). */
export const ADD_CHAIN_PARAMS = {
  chainId: CHAIN_ID_HEX,
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};

export const erc20Abi = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
]);
export const routerAbi = parseAbi([
  "struct ExactInputParams { bytes path; address recipient; uint256 amountIn; uint256 amountOutMinimum; }",
  "function exactInput(ExactInputParams params) payable returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);
export const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);

export interface SwapRoute {
  /** Token addresses, input first. */
  tokens: Address[];
  /** Pool fee (ppm) per hop. */
  fees: number[];
}

/** Minimal shape of a route as the API returns it (TradeRouteView). */
export interface RouteLike {
  path: { address: string }[];
  markets: { marketId: string; feePpm: number | null }[];
}

/**
 * A route this app can execute, or the reason it cannot: every hop must be a Uniswap v3 pool
 * (`4663:uniswap:uniswap-v3-pool:<pool>`) with a known fee tier, 1–2 hops, distinct tokens.
 */
export function executableRoute(r: RouteLike): { ok: true; route: SwapRoute } | { ok: false; reason: "VENUE" | "SHAPE" } {
  if (r.markets.length < 1 || r.markets.length > 2 || r.path.length !== r.markets.length + 1) return { ok: false, reason: "SHAPE" };
  if (!r.markets.every((m) => m.marketId.startsWith(`${CHAIN_ID}:uniswap:`) && FEE_TIERS.includes(m.feePpm as (typeof FEE_TIERS)[number]))) return { ok: false, reason: "VENUE" };
  if (!r.path.every((a) => /^0x[0-9a-fA-F]{40}$/.test(a.address))) return { ok: false, reason: "SHAPE" };
  const tokens = r.path.map((a) => getAddress(a.address));
  if (new Set(tokens.map((a) => a.toLowerCase())).size !== tokens.length) return { ok: false, reason: "SHAPE" };
  return { ok: true, route: { tokens, fees: r.markets.map((m) => m.feePpm!) } };
}

/** Uniswap v3 packed path: token (20) | fee (3) | token (20) | … */
export function encodePath(r: SwapRoute): Hex {
  const types: ("address" | "uint24")[] = [];
  const values: (Address | number)[] = [];
  r.tokens.forEach((t, i) => {
    if (i > 0) {
      types.push("uint24");
      values.push(r.fees[i - 1]!);
    }
    types.push("address");
    values.push(t);
  });
  return encodePacked(types, values);
}

/** Lowest acceptable output for a slippage tolerance in basis points (floor). */
export function minOut(expectedOut: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 5000) throw new Error("slippage out of range");
  return (expectedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

export function quoteCall(r: SwapRoute, amountIn: bigint): { to: Address; data: Hex } {
  return { to: QUOTER_V2, data: encodeFunctionData({ abi: quoterAbi, functionName: "quoteExactInput", args: [encodePath(r), amountIn] }) };
}

export interface Tx {
  from: Address;
  to: Address;
  data: Hex;
  value: "0x0";
}

export function approveTx(from: Address, token: Address, amount: bigint): Tx {
  return { from, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [SWAP_ROUTER, amount] }), value: "0x0" };
}

export function swapTx(input: { from: Address; route: SwapRoute; amountIn: bigint; minOut: bigint; deadline: bigint }): Tx {
  const inner = encodeFunctionData({
    abi: routerAbi,
    functionName: "exactInput",
    args: [{ path: encodePath(input.route), recipient: input.from, amountIn: input.amountIn, amountOutMinimum: input.minOut }],
  });
  return { from: input.from, to: SWAP_ROUTER, data: encodeFunctionData({ abi: routerAbi, functionName: "multicall", args: [input.deadline, [inner]] }), value: "0x0" };
}

/**
 * Last check before a transaction goes to the wallet: it must be one of the two shapes above,
 * for this route and this user, with no ETH value. Throws otherwise.
 */
export function checkTx(tx: Tx, ctx: { user: Address; route: SwapRoute }): "APPROVE" | "SWAP" {
  const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  if (!eq(tx.from, ctx.user) || tx.value !== "0x0") throw new Error("unexpected sender or value");
  if (eq(tx.to, ctx.route.tokens[0]!)) {
    const d = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    if (d.functionName !== "approve" || !eq(d.args[0] as string, SWAP_ROUTER)) throw new Error("unexpected token call");
    return "APPROVE";
  }
  if (!eq(tx.to, SWAP_ROUTER)) throw new Error("unexpected target");
  const outer = decodeFunctionData({ abi: routerAbi, data: tx.data });
  if (outer.functionName !== "multicall" || outer.args.length !== 2) throw new Error("unexpected router call");
  const calls = outer.args[1] as readonly Hex[];
  if (calls.length !== 1) throw new Error("unexpected router batch");
  const inner = decodeFunctionData({ abi: routerAbi, data: calls[0]! });
  if (inner.functionName !== "exactInput") throw new Error("unexpected router call");
  const p = inner.args[0] as { path: Hex; recipient: Address; amountOutMinimum: bigint };
  if (!eq(p.recipient, ctx.user)) throw new Error("recipient is not the user");
  if (p.path.toLowerCase() !== encodePath(ctx.route).toLowerCase()) throw new Error("path mismatch");
  if (p.amountOutMinimum <= 0n) throw new Error("no minimum output");
  return "SWAP";
}

/** Explorer link for a transaction hash. */
export function explorerTx(hash: string): string | null {
  return /^0x[0-9a-fA-F]{64}$/.test(hash) ? `https://robinhoodchain.blockscout.com/tx/${hash}` : null;
}
