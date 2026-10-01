/**
 * Live validation of in-app swaps (nothing is signed or sent):
 *   1. SwapRouter02 identity: code present, factory() == v3 factory, WETH9() == the chain's WETH
 *   2. the browser's QuoterV2 call (web/src/swap) reproduces the server's quote for the same route
 *   3. the exact calldata the browser builds executes on the real router: eth_call from a
 *      throwaway address whose WETH balance and allowance are set by a state override
 *      (1 and 2 hops), returns at least the minimum, and reverts when the minimum is too high.
 */
import { createPublicClient, decodeFunctionResult, encodeAbiParameters, getAddress, http, keccak256, parseAbi, parseEther, type Address, type Hex } from "viem";
import { robinhoodChain } from "../src/config/chains.js";
import { UNISWAP_READ_CONTRACTS } from "../src/protocols/uniswap/constants.js";
import { createRuntime } from "../src/runtime.js";
import { executableRoute, minOut, quoteCall, quoterAbi, routerAbi, SWAP_ROUTER, swapTx, type SwapRoute } from "../web/src/swap/uniswap.js";
import { Report } from "./lib/report.js";

const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USER: Address = getAddress("0x00000000000000000000000000000000c0ffee01"); // unused address
const K = (a: string) => `4663:${a.toLowerCase()}`;

const report = new Report("swap-validation");
const rt = createRuntime();
const client = createPublicClient({ chain: robinhoodChain, transport: http(rt.rpc.url, { retryCount: 4, retryDelay: 1500 }) });

// 1. router identity
const idAbi = parseAbi(["function factory() view returns (address)", "function WETH9() view returns (address)"]);
const [code, factory, weth9] = await Promise.all([client.getCode({ address: SWAP_ROUTER }), client.readContract({ address: SWAP_ROUTER, abi: idAbi, functionName: "factory" }), client.readContract({ address: SWAP_ROUTER, abi: idAbi, functionName: "WETH9" })]);
const idOk = !!code && code.length > 2 && factory.toLowerCase() === UNISWAP_READ_CONTRACTS.v3Factory && weth9.toLowerCase() === WETH.toLowerCase();
report.add(idOk ? "PASS" : "FAIL", "SwapRouter02 identity", `${SWAP_ROUTER}: ${(code?.length ?? 2) / 2 - 1} bytes, factory ${factory}, WETH9 ${weth9}`);

// 2. browser quote == server quote for the top executable routes
async function serverRoute(from: Address, to: Address, amount: bigint) {
  const routes = await rt.opportunities.getTradeRoutes(K(from), K(to));
  for (const r of [...routes.data.direct, ...routes.data.oneHop]) {
    const view = { path: [r.input, ...r.intermediates, r.output].map((a) => ({ address: a.address })), markets: r.hops.map((h) => ({ marketId: h.marketId, feePpm: h.fee?.ppm ?? null })) };
    const ex = executableRoute(view);
    if (!ex.ok) continue;
    const q = await rt.opportunities.getTradeQuote(r, amount);
    if (q.ok) return { route: ex.route, serverOut: q.quote.expectedOutput.raw, block: q.quote.blockNumber };
  }
  return null;
}
async function browserQuote(route: SwapRoute, amountIn: bigint): Promise<bigint> {
  const c = quoteCall(route, amountIn);
  const r = await client.call({ to: c.to, data: c.data });
  return decodeFunctionResult({ abi: quoterAbi, functionName: "quoteExactInput", data: r.data! })[0];
}
for (const [from, to, amt, label] of [[NVDA, USDG, parseEther("1"), "1 NVDA → USDG"], [WETH, NVDA, parseEther("0.01"), "0.01 WETH → NVDA"]] as const) {
  const s = await serverRoute(from, to, amt);
  if (!s) {
    report.add("WARN", `quote parity ${label}`, "no executable Uniswap v3 route with a quote");
    continue;
  }
  const b = await browserQuote(s.route, amt);
  const diffBps = s.serverOut === 0n ? 0n : ((b > s.serverOut ? b - s.serverOut : s.serverOut - b) * 10_000n) / s.serverOut;
  report.add(diffBps <= 10n ? "PASS" : "FAIL", `quote parity ${label}`, `${s.route.tokens.length - 1} hop(s), fees ${s.route.fees.join("/")}: server ${s.serverOut} @${s.block}, browser ${b} (Δ ${diffBps} bps)`);
}

// 3. execute the browser's calldata on the real router (state override, eth_call only)
const slot = (key: Address, index: bigint | Hex) => keccak256(encodeAbiParameters([{ type: "address" }, { type: index === 0n || typeof index === "bigint" ? "uint256" : "bytes32" }], [key, index as never]));
const amountIn = parseEther("0.01");
const pad = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as Hex;
// Find WETH's balance/allowance mapping slots by probing (Solidity layouts 0..159 — Arbitrum's
// aeWETH is OpenZeppelin-upgradeable with gaps — and the
// OpenZeppelin v5 namespaced ERC20 storage), instead of assuming a layout.
const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"]);
const OZ5 = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const bases = [...Array.from({ length: 160 }, (_, i) => BigInt(i)), OZ5, OZ5 + 1n];
let balSlot: Hex | null = null;
let allowSlot: Hex | null = null;
for (const b of bases) {
  const sBal = slot(USER, b);
  if (!balSlot && (await client.readContract({ address: WETH, abi: balAbi, functionName: "balanceOf", args: [USER], stateOverride: [{ address: WETH, stateDiff: [{ slot: sBal, value: pad(amountIn) }] }] })) === amountIn) balSlot = sBal;
  const sAll = slot(SWAP_ROUTER, slot(USER, b));
  if (!allowSlot && (await client.readContract({ address: WETH, abi: balAbi, functionName: "allowance", args: [USER, SWAP_ROUTER], stateOverride: [{ address: WETH, stateDiff: [{ slot: sAll, value: pad(amountIn) }] }] })) === amountIn) allowSlot = sAll;
  if (balSlot && allowSlot) break;
}
if (!balSlot || !allowSlot) {
  report.add("FAIL", "state override", "could not locate WETH balance/allowance storage");
  process.exit(report.finish());
}
const stateOverride = [{ address: WETH, stateDiff: [{ slot: balSlot, value: pad(amountIn) }, { slot: allowSlot, value: pad(amountIn) }] }];
const bal = await client.readContract({ address: WETH, abi: balAbi, functionName: "balanceOf", args: [USER], stateOverride });
report.add(bal === amountIn ? "PASS" : "FAIL", "state override", `throwaway address holds ${bal} wei WETH in the simulation only`);

for (const [route, label] of [
  [{ tokens: [WETH, USDG].map((a) => getAddress(a)), fees: [] as number[] }, "WETH → USDG"],
  [{ tokens: [WETH, USDG, NVDA].map((a) => getAddress(a)), fees: [] as number[] }, "WETH → USDG → NVDA"],
] as const) {
  // Pick the fee tier per hop from the server's own route list (the most liquid Uniswap v3 pool).
  const s = await serverRoute(route.tokens[0]!, route.tokens.at(-1)!, amountIn);
  const r: SwapRoute = s && s.route.tokens.length === route.tokens.length ? s.route : { tokens: [...route.tokens], fees: route.tokens.slice(1).map(() => 500) };
  const expected = await browserQuote(r, amountIn);
  const min = minOut(expected, 50);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const tx = swapTx({ from: USER, route: r, amountIn, minOut: min, deadline });
  let executed = false;
  try {
    const res = await client.call({ account: USER, to: tx.to, data: tx.data, stateOverride });
    const [inner] = decodeFunctionResult({ abi: routerAbi, functionName: "multicall", data: res.data! });
    const out = decodeFunctionResult({ abi: routerAbi, functionName: "exactInput", data: inner! });
    executed = out >= min;
    report.add(out >= min ? "PASS" : "FAIL", `execute ${label}`, `${r.tokens.map((t) => t.slice(0, 8)).join(" → ")} fees ${r.fees.join("/")}: out ${out} ≥ min ${min} (quote ${expected})`);
  } catch (e) {
    report.add("FAIL", `execute ${label}`, (e as Error).message.split("\n")[0]!);
  }
  const tooHigh = swapTx({ from: USER, route: r, amountIn, minOut: expected * 2n, deadline });
  const reverted = await client.call({ account: USER, to: tooHigh.to, data: tooHigh.data, stateOverride }).then(() => false, () => true);
  report.add(reverted && executed ? "PASS" : "FAIL", `minimum enforced ${label}`, reverted ? "reverts when the minimum is above what the pool gives" : "did NOT revert with minOut = 2× quote");
}

process.exit(report.finish());
