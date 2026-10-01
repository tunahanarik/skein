/** In-app swaps: route eligibility, calldata, and the last-line transaction check. */
import { decodeFunctionData, getAddress, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { UNISWAP_READ_CONTRACTS, UNISWAP_RECORDED_ONLY, V3_FEE_TIERS } from "../../src/protocols/uniswap/constants.js";
import { ROBINHOOD_CHAIN_ID, PUBLIC_RPC_URL } from "../../src/config/chains.js";
import { ADD_CHAIN_PARAMS, approveTx, CHAIN_ID, checkTx, encodePath, executableRoute, FEE_TIERS, minOut, QUOTER_V2, routerAbi, SWAP_ROUTER, swapTx, type SwapRoute } from "../../web/src/swap/uniswap.js";

const NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const USER = getAddress("0x00000000000000000000000000000000000000aa");
const pool = (p: string, n: number) => `4663:${p}:x:0x${String(n).padStart(40, "0")}`;

const twoHop = { path: [{ address: NVDA }, { address: WETH }, { address: USDG }], markets: [{ marketId: pool("uniswap", 1), feePpm: 500 }, { marketId: pool("uniswap", 2), feePpm: 100 }] };
const route = (executableRoute(twoHop) as { route: SwapRoute }).route;

describe("swap constants", () => {
  it("match the server's verified Uniswap deployment and chain config", () => {
    expect(SWAP_ROUTER).toBe(UNISWAP_RECORDED_ONLY.v3SwapRouter02);
    expect(QUOTER_V2).toBe(UNISWAP_READ_CONTRACTS.quoterV2);
    expect([...FEE_TIERS].sort()).toEqual(Object.keys(V3_FEE_TIERS).map(Number).sort());
    expect(CHAIN_ID).toBe(ROBINHOOD_CHAIN_ID);
    expect(Number(ADD_CHAIN_PARAMS.chainId)).toBe(ROBINHOOD_CHAIN_ID);
    expect(ADD_CHAIN_PARAMS.rpcUrls).toEqual([PUBLIC_RPC_URL]);
  });
});

describe("executableRoute", () => {
  it("accepts Uniswap v3 routes of 1–2 hops with known fee tiers", () => {
    expect(route.tokens).toEqual([getAddress(NVDA), getAddress(WETH), getAddress(USDG)]);
    expect(route.fees).toEqual([500, 100]);
    expect(executableRoute({ path: twoHop.path.slice(0, 2), markets: twoHop.markets.slice(0, 1) }).ok).toBe(true);
  });
  it("rejects other venues, odd fees and malformed shapes", () => {
    expect(executableRoute({ ...twoHop, markets: [twoHop.markets[0]!, { marketId: pool("uniswap-v4", 2), feePpm: 100 }] })).toEqual({ ok: false, reason: "VENUE" });
    expect(executableRoute({ ...twoHop, markets: [twoHop.markets[0]!, { marketId: pool("ramses", 2), feePpm: 100 }] })).toEqual({ ok: false, reason: "VENUE" });
    expect(executableRoute({ ...twoHop, markets: [twoHop.markets[0]!, { marketId: pool("uniswap", 2), feePpm: 1234 }] })).toEqual({ ok: false, reason: "VENUE" });
    expect(executableRoute({ ...twoHop, markets: [twoHop.markets[0]!, { marketId: pool("uniswap", 2), feePpm: null }] })).toEqual({ ok: false, reason: "VENUE" });
    expect(executableRoute({ path: twoHop.path, markets: twoHop.markets.slice(0, 1) })).toEqual({ ok: false, reason: "SHAPE" });
    expect(executableRoute({ path: [{ address: NVDA }, { address: NVDA }], markets: twoHop.markets.slice(0, 1) })).toEqual({ ok: false, reason: "SHAPE" });
    expect(executableRoute({ path: [{ address: "0xnot" }, { address: WETH }], markets: twoHop.markets.slice(0, 1) })).toEqual({ ok: false, reason: "SHAPE" });
  });
});

describe("calldata", () => {
  it("packs the v3 path as token | fee(3 bytes) | token", () => {
    expect(encodePath(route)).toBe(`0x${NVDA.slice(2)}0001f4${WETH.slice(2)}000064${USDG.slice(2)}`);
  });
  it("minOut floors and bounds the tolerance", () => {
    expect(minOut(1_000_000n, 50)).toBe(995_000n);
    expect(minOut(999n, 50)).toBe(994n);
    expect(() => minOut(1n, -1)).toThrow();
    expect(() => minOut(1n, 5001)).toThrow();
    expect(() => minOut(1n, 0.5)).toThrow();
  });
  it("swap = multicall(deadline, [exactInput(path, user, amountIn, minOut)]) on SwapRouter02, no value", () => {
    const tx = swapTx({ from: USER, route, amountIn: 10n ** 18n, minOut: 123n, deadline: 1_900_000_000n });
    expect(tx.to).toBe(SWAP_ROUTER);
    expect(tx.value).toBe("0x0");
    const outer = decodeFunctionData({ abi: routerAbi, data: tx.data });
    expect(outer.functionName).toBe("multicall");
    expect(outer.args[0]).toBe(1_900_000_000n);
    const inner = decodeFunctionData({ abi: routerAbi, data: (outer.args[1] as readonly `0x${string}`[])[0]! });
    expect(inner.args[0]).toEqual({ path: encodePath(route), recipient: USER, amountIn: 10n ** 18n, amountOutMinimum: 123n });
    expect(checkTx(tx, { user: USER, route })).toBe("SWAP");
  });
  it("approve targets the input token, for the router, exact amount", () => {
    const tx = approveTx(USER, route.tokens[0]!, 5n);
    expect(tx.to).toBe(route.tokens[0]);
    expect(checkTx(tx, { user: USER, route })).toBe("APPROVE");
  });
});

describe("checkTx refuses anything else", () => {
  const ok = swapTx({ from: USER, route, amountIn: 1n, minOut: 1n, deadline: 1n });
  const other = "0x00000000000000000000000000000000000000bb" as Address;
  it.each([
    ["another sender", { ...ok, from: other }],
    ["ETH value", { ...ok, value: "0x1" as "0x0" }],
    ["another target", { ...ok, to: other }],
    ["output to someone else", swapTx({ from: USER, route: { ...route }, amountIn: 1n, minOut: 1n, deadline: 1n }) && { ...ok, data: swapTx({ from: other, route, amountIn: 1n, minOut: 1n, deadline: 1n }).data }],
    ["no minimum", swapTx({ from: USER, route, amountIn: 1n, minOut: 0n, deadline: 1n })],
    ["a different path", swapTx({ from: USER, route: { tokens: [route.tokens[0]!, route.tokens[2]!], fees: [3000] }, amountIn: 1n, minOut: 1n, deadline: 1n })],
    ["approve to another spender", { ...approveTx(USER, route.tokens[0]!, 1n), data: approveTx(USER, route.tokens[0]!, 1n).data.replace(SWAP_ROUTER.slice(2), other.slice(2)) as `0x${string}` }],
    ["approve on another token", approveTx(USER, route.tokens[2]!, 1n)],
  ])("%s", (_name, tx) => {
    expect(() => checkTx(tx as typeof ok, { user: USER, route })).toThrow();
  });
});
