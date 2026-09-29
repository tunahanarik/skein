/** Bridge (LI.FI): quote parsing and the check every quote must pass before the wallet sees it. */
import { describe, expect, it } from "vitest";
import { LIFI_DIAMONDS } from "../../web/src/bridge/diamonds.js";
import { checkBridgeQuote, cleanText, NATIVE, parseToken, type Quote, type QuoteRequest } from "../../web/src/bridge/lifi.js";

const USER = "0x00000000000000000000000000000000000000Aa" as const;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const tok = (chainId: number, address: `0x${string}`, symbol: string, decimals: number) => ({ chainId, address, symbol, name: symbol, decimals, priceUSD: 1, verified: true, logo: null });

const req: QuoteRequest = { fromChainId: 8453, toChainId: 4663, fromToken: USDC_BASE, toToken: NATIVE, fromAmount: 50_000_000n, user: USER, slippage: 0.005, order: "CHEAPEST" };
const good: Quote = {
  tool: "across",
  toolName: "AcrossV4",
  fromChainId: 8453,
  toChainId: 4663,
  fromToken: tok(8453, USDC_BASE, "USDC", 6),
  toToken: tok(4663, NATIVE, "ETH", 18),
  fromAmount: 50_000_000n,
  toAmount: 18_471_400_890_026_136n,
  toAmountMin: 18_379_043_885_576_006n,
  fromAddress: USER,
  toAddress: USER,
  approvalAddress: LIFI_DIAMONDS[8453]!.diamond,
  durationS: 2,
  feesUsd: 0.16,
  gasUsd: 0.01,
  extraNativeFee: 0n,
  fromAmountUsd: 50,
  toAmountUsd: 49.8,
  tx: { from: USER, to: LIFI_DIAMONDS[8453]!.diamond, data: "0x4c279d6b", value: "0x0", chainId: 8453 },
};

describe("pinned LI.FI diamonds", () => {
  it("include Robinhood Chain and the major source chains, with valid addresses", () => {
    expect(LIFI_DIAMONDS[4663]?.diamond).toBe("0xB477751B76CF82d00a686A1232f5fCD772414Af3");
    for (const id of [1, 10, 56, 137, 8453, 42161]) expect(LIFI_DIAMONDS[id]?.diamond).toBe("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
    for (const p of Object.values(LIFI_DIAMONDS)) expect(p.diamond).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});

describe("checkBridgeQuote", () => {
  it("accepts a quote that matches the request", () => {
    expect(() => checkBridgeQuote(good, req)).not.toThrow();
  });
  it("accepts native input whose value is the amount (+ declared native fee)", () => {
    const r: QuoteRequest = { ...req, fromChainId: 1, fromToken: NATIVE, fromAmount: 10n ** 16n };
    const q: Quote = { ...good, fromChainId: 1, fromToken: tok(1, NATIVE, "ETH", 18), fromAmount: 10n ** 16n, approvalAddress: null, tx: { ...good.tx, chainId: 1, to: LIFI_DIAMONDS[1]!.diamond, value: "0x2386f26fc10000" } };
    expect(() => checkBridgeQuote(q, r)).not.toThrow();
    expect(() => checkBridgeQuote({ ...q, tx: { ...q.tx, value: "0x2386f26fc10001" } }, r)).toThrow("value");
    expect(() => checkBridgeQuote({ ...q, extraNativeFee: 1n, tx: { ...q.tx, value: "0x2386f26fc10001" } }, r)).not.toThrow();
  });
  it.each<[string, Partial<Quote>]>([
    ["another contract", { tx: { ...good.tx, to: "0x000000000000000000000000000000000000dEaD" } }],
    ["the destination chain's diamond on the source chain", { tx: { ...good.tx, to: LIFI_DIAMONDS[4663]!.diamond } }],
    ["another spender", { approvalAddress: "0x000000000000000000000000000000000000dEaD" }],
    ["another recipient", { toAddress: "0x000000000000000000000000000000000000dEaD" }],
    ["another sender", { tx: { ...good.tx, from: "0x000000000000000000000000000000000000dEaD" } }],
    ["another amount", { fromAmount: 50_000_001n }],
    ["another output token", { toToken: tok(4663, "0x0A3B763d00000000000000000000000000000000", "USDG", 6) }],
    ["another destination chain", { toChainId: 8453 }],
    ["tx on another chain", { tx: { ...good.tx, chainId: 1 } }],
    ["ETH value on an ERC-20 bridge", { tx: { ...good.tx, value: "0x1" } }],
    ["no minimum", { toAmountMin: 0n }],
  ])("refuses %s", (_n, patch) => {
    expect(() => checkBridgeQuote({ ...good, ...patch }, req)).toThrow();
  });
  it("refuses a source chain that is not pinned", () => {
    expect(() => checkBridgeQuote({ ...good, fromChainId: 999999, tx: { ...good.tx, chainId: 999999 } }, { ...req, fromChainId: 999999 })).toThrow("not supported");
  });
});

describe("untrusted token metadata", () => {
  it("strips control and bidi characters and bounds length", () => {
    expect(cleanText("US‮DC\u0000")).toBe("USDC");
    expect(cleanText("x".repeat(100), 16)).toHaveLength(16);
    expect(cleanText(42)).toBe("");
  });
  it("parses tokens, normalizing the native placeholder and rejecting bad fields", () => {
    expect(parseToken({ chainId: 1, address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", symbol: "ETH", decimals: 18 })?.address).toBe(NATIVE);
    expect(parseToken({ chainId: 1, address: "0xnope", symbol: "X", decimals: 18 })).toBeNull();
    expect(parseToken({ chainId: 1, address: USDC_BASE, symbol: "X", decimals: 99 })).toBeNull();
    expect(parseToken({ chainId: 1, address: USDC_BASE, symbol: "USDC", decimals: 6, verificationStatus: "verified" })?.verified).toBe(true);
  });
});

describe("image proxy (bridge token and network logos)", async () => {
  const { allowedImageUrl, ImageProxy, sniffAny } = await import("../../src/server/images.js");
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const respond = (b: Buffer, calls: string[] = []) => (async (u: string) => (calls.push(String(u)), new Response(new Uint8Array(b), { status: 200 }))) as unknown as typeof fetch;

  it("only allowlisted https hosts and paths", () => {
    expect(allowedImageUrl("https://static.debank.com/image/eth_token/logo_url/x.png")).not.toBeNull();
    expect(allowedImageUrl("https://raw.githubusercontent.com/lifinance/types/main/src/assets/icons/chains/ethereum.svg")).not.toBeNull();
    for (const bad of [
      "http://static.debank.com/x.png",
      "https://raw.githubusercontent.com/someone/else/x.png",
      "https://static.debank.com.evil.io/x.png",
      "https://u:p@static.debank.com/x.png",
      "https://static.debank.com:8443/x.png",
      "https://127.0.0.1/x.png",
      "not a url",
    ])
      expect([bad, allowedImageUrl(bad)]).toEqual([bad, null]);
  });

  it("sniffs raster images and SVG, rejects HTML", () => {
    expect(sniffAny(PNG)).toBe("png");
    expect(sniffAny(Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBe("svg");
    expect(sniffAny(Buffer.from("<html><body>hi</body></html>"))).toBeNull();
  });

  it("never fetches a URL outside the allowlist, and rejects oversize bodies", async () => {
    const calls: string[] = [];
    expect(await new ImageProxy({ fetch: respond(PNG, calls) }).get("https://evil.example/x.png")).toBeNull();
    expect(calls).toEqual([]);
    expect((await new ImageProxy({ fetch: respond(PNG) }).get("https://static.debank.com/x.png"))?.contentType).toBe("image/png");
    expect(await new ImageProxy({ fetch: respond(Buffer.concat([PNG, Buffer.alloc(300_000)])) }).get("https://static.debank.com/y.png")).toBeNull();
  });
});
