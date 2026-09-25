/**
 * Live validation of in-app bridging (nothing is signed or sent):
 *   1. every pinned LI.FI diamond (web/src/bridge/diamonds.ts) equals LI.FI's live /chains answer
 *   2. …and LI.FI's own deployment record on GitHub (lifinance/contracts) for major chains
 *   3. the Robinhood Chain diamond has code on-chain
 *   4. real quotes in both directions pass the browser's checkBridgeQuote (throwaway address)
 */
import { createPublicClient, http, parseEther, parseUnits, type Address } from "viem";
import { robinhoodChain } from "../src/config/chains.js";
import { LIFI_DIAMONDS } from "../web/src/bridge/diamonds.js";
import { checkBridgeQuote, LIFI_API, NATIVE, quote, type QuoteRequest } from "../web/src/bridge/lifi.js";
import { Report } from "./lib/report.js";

const report = new Report("bridge-validation");
const USER: Address = "0x00000000000000000000000000000000C0FfEe01".toLowerCase() as Address;

// 1. pins vs live
const live = (await (await fetch(`${LIFI_API}/chains?chainTypes=EVM`)).json()) as { chains: { id: number; diamondAddress?: string; mainnet: boolean; key: string }[] };
const liveMap = new Map(live.chains.map((c) => [c.id, c]));
const drift = Object.entries(LIFI_DIAMONDS).filter(([id, p]) => liveMap.get(Number(id))?.diamondAddress?.toLowerCase() !== p.diamond.toLowerCase());
report.add(drift.length ? "FAIL" : "PASS", "pinned diamonds vs li.quest", drift.length ? `changed: ${drift.map(([id]) => id).join(", ")}` : `${Object.keys(LIFI_DIAMONDS).length} chains match`);
const newChains = live.chains.filter((c) => c.mainnet && c.diamondAddress && !LIFI_DIAMONDS[c.id]).map((c) => c.id);
if (newChains.length) report.add("INFO", "unpinned chains", `LI.FI also lists ${newChains.join(", ")} (not offered until pinned)`);

// 2. pins vs LI.FI's GitHub deployment records
const files: Record<number, string> = { 1: "mainnet", 10: "optimism", 56: "bsc", 137: "polygon", 8453: "base", 42161: "arbitrum", 43114: "avalanche", 59144: "linea", 4663: "robinhood" };
for (const [id, file] of Object.entries(files)) {
  const r = await fetch(`https://raw.githubusercontent.com/lifinance/contracts/main/deployments/${file}.json`);
  const d = r.ok ? ((await r.json()) as Record<string, string>).LiFiDiamond : undefined;
  const pin = LIFI_DIAMONDS[Number(id)]?.diamond;
  report.add(d && pin && d.toLowerCase() === pin.toLowerCase() ? "PASS" : "FAIL", `GitHub record ${file}`, `deployments/${file}.json LiFiDiamond ${d ?? "missing"} vs pinned ${pin ?? "none"}`);
}

// 3. Robinhood diamond code
const code = await createPublicClient({ chain: robinhoodChain, transport: http() }).getCode({ address: LIFI_DIAMONDS[4663]!.diamond });
report.add(code && code.length > 2 ? "PASS" : "FAIL", "Robinhood Chain diamond code", `${((code?.length ?? 2) - 2) / 2} bytes at ${LIFI_DIAMONDS[4663]!.diamond}`);

// 4. real quotes
const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB: Address = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const cases: [string, Omit<QuoteRequest, "user" | "slippage" | "order">][] = [
  ["Ethereum ETH → Robinhood ETH", { fromChainId: 1, toChainId: 4663, fromToken: NATIVE, toToken: NATIVE, fromAmount: parseEther("0.05") }],
  ["Base USDC → Robinhood ETH", { fromChainId: 8453, toChainId: 4663, fromToken: USDC_BASE, toToken: NATIVE, fromAmount: parseUnits("50", 6) }],
  ["Arbitrum USDC → Robinhood USDG", { fromChainId: 42161, toChainId: 4663, fromToken: USDC_ARB, toToken: USDG, fromAmount: parseUnits("50", 6) }],
  ["Robinhood ETH → Base ETH", { fromChainId: 4663, toChainId: 8453, fromToken: NATIVE, toToken: NATIVE, fromAmount: parseEther("0.02") }],
  ["Robinhood USDG → Arbitrum USDC", { fromChainId: 4663, toChainId: 42161, fromToken: USDG, toToken: USDC_ARB, fromAmount: parseUnits("50", 6) }],
];
for (const [label, c] of cases) {
  const req: QuoteRequest = { ...c, user: USER, slippage: 0.005, order: "CHEAPEST" };
  try {
    const q = await quote(req);
    checkBridgeQuote(q, req);
    report.add("PASS", `quote ${label}`, `${q.toolName}: out ${q.toAmount} (min ${q.toAmountMin}) ${q.toToken.symbol}, fees $${q.feesUsd.toFixed(2)}, value ${BigInt(q.tx.value)}, extra native fee ${q.extraNativeFee}, ~${q.durationS}s, to ${q.tx.to}`);
  } catch (e) {
    const m = (e as Error).message;
    report.add(/no available quotes|No routes|not found/i.test(m) ? "WARN" : "FAIL", `quote ${label}`, m.slice(0, 200));
  }
}
process.exit(report.finish());
