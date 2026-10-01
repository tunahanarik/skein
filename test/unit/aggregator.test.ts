/** Aggregator coverage and the KyberSwap transaction check. */
import { encodeFunctionData, type Address } from "viem";
import { describe, expect, it } from "vitest";
import { AggregatorScanner, best, classify } from "../../src/product/aggregator.js";
import { checkKyberTx, KYBER_ROUTER, kyberRouterAbi } from "../../web/src/swap/kyber.js";

const USER: Address = "0x00000000000000000000000000000000000000aa";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

function kyberTx(o: Partial<{ to: Address; value: `0x${string}`; src: Address; dst: Address; receiver: Address; amount: bigint; min: bigint; feeReceivers: Address[]; feeAmounts: bigint[] }> = {}) {
  const data = encodeFunctionData({
    abi: kyberRouterAbi,
    functionName: "swap",
    args: [
      {
        callTarget: "0x0000000000000000000000000000000000000001",
        approveTarget: "0x0000000000000000000000000000000000000001",
        targetData: "0x",
        desc: { srcToken: o.src ?? USDG, dstToken: o.dst ?? NVDA, srcReceivers: [], srcAmounts: [], feeReceivers: o.feeReceivers ?? [], feeAmounts: o.feeAmounts ?? [], dstReceiver: o.receiver ?? USER, amount: o.amount ?? 100n, minReturnAmount: o.min ?? 1n, flags: 0n, permit: "0x" },
        clientData: "0x",
      },
    ],
  });
  return { to: o.to ?? KYBER_ROUTER, data, value: o.value ?? ("0x0" as const) };
}
const req = { user: USER, tokenIn: USDG, tokenOut: NVDA, amountIn: 100n };

describe("checkKyberTx", () => {
  it("accepts swap(desc) on the pinned router for exactly the request", () => {
    expect(checkKyberTx(kyberTx(), req)).toEqual({ minOut: 1n });
  });
  it.each<[string, Parameters<typeof kyberTx>[0]]>([
    ["another router", { to: "0x000000000000000000000000000000000000dEaD" }],
    ["ETH value", { value: "0x1" }],
    ["another input token", { src: NVDA }],
    ["another output token", { dst: USDG }],
    ["another amount", { amount: 101n }],
    ["output to someone else", { receiver: "0x000000000000000000000000000000000000dEaD" }],
    ["no minimum", { min: 0n }],
    ["a fee receiver", { feeReceivers: ["0x000000000000000000000000000000000000dEaD"], feeAmounts: [1n] }],
  ])("refuses %s", (_n, o) => {
    expect(() => checkKyberTx(kyberTx(o), req)).toThrow();
  });
});

describe("aggregator scan", () => {
  it("classifies by value lost against the oracle", () => {
    expect([classify(0.004), classify(0.02), classify(0.05), classify(null)]).toEqual(["GOOD", "OK", "EXPENSIVE", "NO_PRICE"]);
    expect(best([{ via: "kyber", cls: "EXPENSIVE", loss: 0.05 } as never, { via: "lifi", cls: "GOOD", loss: 0.002 } as never])!.via).toBe("lifi");
  });

  it("keeps the better source, marks NO_ROUTE only on an explicit answer, and pauses LI.FI on a rate limit", async () => {
    const tokens = [
      { key: "4663:a", symbol: "AAA", address: "0x00000000000000000000000000000000000000a1" as const, decimals: 18 },
      { key: "4663:b", symbol: "BBB", address: "0x00000000000000000000000000000000000000b1" as const, decimals: 18 },
    ];
    let lifiCalls = 0;
    const scanner = new AggregatorScanner({
      tokens: async () => tokens,
      prices: async () => new Map([["4663:a", 10], ["4663:b", 10], [`4663:${USDG.toLowerCase()}`, 1]]),
      // AAA: 9.8 tokens for $100 at $10 → 2% loss; BBB: no route.
      kyber: async (_i, out) => {
        if (out === tokens[1]!.address) throw new Error("route not found");
        return { amountOut: 98n * 10n ** 17n, exchanges: ["up-v3"], routerAddress: KYBER_ROUTER, summary: {} };
      },
      lifi: async () => {
        lifiCalls++;
        throw new Error("Too many requests");
      },
      spacingMs: 0,
    });
    await scanner.scan();
    const a = scanner.get("4663:a")!;
    expect(a.cls).toBe("OK");
    expect(a.via).toBe("kyber");
    expect(a.verifiedTool).toBe(true);
    expect(a.loss).toBeCloseTo(0.02);
    expect(scanner.get("4663:b")!.cls).toBe("NO_ROUTE");
    expect(lifiCalls).toBe(1); // stopped at the first rate limit
  });
});
