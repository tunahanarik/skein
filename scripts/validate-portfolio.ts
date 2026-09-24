/**
 * Phase 1 live validation (read-only): network, registry, Multicall3, balances, Chainlink,
 * Robinhood fallback, USDG, and full Portfolio Engine runs with internal consistency checks.
 *
 * Test wallets: PORTFOLIO_TEST_WALLETS=0xA,0xB (public addresses). If unset, holders are
 * discovered from recent Transfer logs. Reports never contain wallet addresses — only a
 * short hash — and the snapshot file is gitignored.
 */
import { createHash } from "node:crypto";
import { parseAbiItem, type Address } from "viem";
import { createPublicClient, http } from "viem";
import { robinhoodChain } from "../src/config/chains.js";
import { CORE_ASSETS } from "../src/config/assets.js";
import { usdValueE18 } from "../src/lib/units.js";
import { calculateStockDisplayBalance } from "../src/lib/stockToken.js";
import { diffRegistries } from "../src/registry/diff.js";
import { createRuntime } from "../src/runtime.js";
import type { Portfolio } from "../src/portfolio/types.js";
import { Report } from "./lib/report.js";

const redact = (a: string) => "wallet#" + createHash("sha256").update(a.toLowerCase()).digest("hex").slice(0, 10);
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Find recent recipients of `token` that are EOAs (no code). Public chain data only. */
async function discoverHolders(rpcUrl: string, token: Address, want: number): Promise<Address[]> {
  const client = createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl, { retryCount: 3 }) });
  const head = await client.getBlockNumber();
  const logs = await client.getLogs({ address: token, event: transfer, fromBlock: head - 3_000n, toBlock: head });
  const out: Address[] = [];
  for (const l of logs.reverse()) {
    const to = l.args.to;
    if (!to || out.includes(to) || /^0x0{40}$/i.test(to)) continue;
    const code = await client.getCode({ address: to });
    if (!code || code === "0x") out.push(to);
    if (out.length >= want) break;
  }
  return out;
}

function checkConsistency(p: Portfolio): string[] {
  const problems: string[] = [];
  let sum = 0n;
  for (const r of p.assets) {
    if (r.pricingStatus === "PRICED") {
      const q = r.price!.priceUsd!;
      const expect = usdValueE18(r.rawBalance!, r.asset.decimals, q.raw, q.decimals);
      if (expect !== r.valueUsdE18) problems.push(`${r.asset.symbol}: value ≠ raw × price`);
      sum += r.valueUsdE18!;
    }
    if (r.stock) {
      const d = calculateStockDisplayBalance(r.rawBalance!, r.stock.uiMultiplierE18);
      if (d.displayShareBalanceRaw !== r.stock.displayShareBalanceRaw) problems.push(`${r.asset.symbol}: display shares mismatch`);
    }
    if (r.provenance.length === 0) problems.push(`${r.asset.symbol}: no provenance`);
    if (r.price?.provenance.some((s) => /morpho/i.test(s.provider))) problems.push(`${r.asset.symbol}: priced from Morpho`);
    if (!r.asset.canonical && r.pricingStatus === "PRICED") problems.push(`${r.asset.symbol}: non-canonical asset priced`);
  }
  if (sum !== p.totals.pricedValueUsdE18) problems.push("totals ≠ sum of priced rows");
  if (p.valuationCoverage.coverageStatus === "COMPLETE" && (p.totals.unpricedAssetCount > 0 || p.totals.failedBalanceCount > 0)) problems.push("COMPLETE with gaps");
  if (p.chainId !== 4663) problems.push("chainId");
  return problems;
}

export async function validatePortfolio(report = new Report("portfolio-validation")) {
  const rt = createRuntime();
  report.info("rpc", `${rt.rpc.isPublicRpc ? "public" : "dedicated"} endpoint`);

  // ---- network ----
  await rt.reader.assertChainId();
  const block = await rt.reader.getLatestBlock();
  report.pass("network", `chainId 4663, block ${block.number}, age ${Math.floor(Date.now() / 1000) - Number(block.timestamp)}s`);

  // ---- registry ----
  const t0 = performance.now();
  const registry = await rt.getRegistry();
  const regMs = Math.round(performance.now() - t0);
  const s = registry.status;
  if (s.mode !== "LIVE") report.fail("registry", `mode ${s.mode}: ${s.liveError}`);
  else report.pass("registry", `LIVE, ${s.stockTokenCount} canonical Stock Tokens, freshness ${s.freshness.status}, ${regMs} ms (incl. onchain identity check)`);
  const onchain = s.onchain!;
  if (onchain.mismatched.length || onchain.verified !== s.stockTokenCount) report.fail("registry onchain identity", `${onchain.verified}/${onchain.checked} verified, ${onchain.mismatched.length} mismatched, ${onchain.unreadable} unreadable`, { mismatched: onchain.mismatched });
  else report.pass("registry onchain identity", `${onchain.verified}/${onchain.checked} Stock Tokens match uid/symbol/decimals/registry at block ${onchain.blockNumber}`);
  if (rt.baseline) {
    const d = s.diff ?? diffRegistries(rt.baseline.entries, []);
    const kinds = [...new Set(d.changes.map((c) => c.kind))].join(", ") || "none";
    if (d.identityChangeCount > 0) report.fail("registry vs snapshot", `${d.identityChangeCount} identity changes`, { changes: d.changes });
    else report.pass("registry vs snapshot", `snapshot ${rt.baseline.contentHash.slice(0, 19)}… integrity OK; ${d.changes.length} non-identity changes (${kinds})`);
  } else report.warn("registry vs snapshot", "no committed snapshot");
  if (s.issues.length) report.warn("registry issues", s.issues.map((i) => i.code).join(", "));

  // ---- Multicall3 + prices on known assets ----
  const probe = await rt.reader.multicall(
    registry.canonical().filter((a) => a.address).slice(0, 50).map((a) => ({ address: a.address!, abi: [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const, functionName: "decimals" })),
    { blockNumber: block.number },
  );
  const ok = probe.filter((r) => r.status === "success").length;
  if (ok === probe.length) report.pass("multicall3", `${ok}/${probe.length} calls in one aggregate3`);
  else report.fail("multicall3", `${ok}/${probe.length} succeeded`);

  const nvda = registry.get(4663, NVDA)!;
  const eth = registry.get(4663, null)!;
  const usdg = registry.get(4663, CORE_ASSETS.USDG.address)!;
  const noFeed = registry.canonical().find((a) => a.symbol === "TTWO") ?? registry.canonical().find((a) => a.type === "STOCK_TOKEN" && !["NVDA", "AAPL", "TSLA"].includes(a.symbol))!;
  const multOf = async (addr: Address) =>
    (await rt.reader.readContract({ address: addr, abi: [{ type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const, functionName: "uiMultiplier" }, { blockNumber: block.number })) as bigint;
  const src = { type: "ONCHAIN" as const, provider: "robinhood-chain-rpc", observedAt: new Date().toISOString() };
  const batch = await rt.prices.priceAssets(
    [
      { asset: eth },
      { asset: usdg },
      { asset: nvda, multiplier: { valueE18: await multOf(NVDA), source: "ONCHAIN", provenance: src } },
      { asset: noFeed, multiplier: { valueE18: await multOf(noFeed.address!), source: "ONCHAIN", provenance: src } },
    ],
    { blockNumber: block.number },
  );
  const q = (k: string) => batch.quotes.get(k)!;
  const e = q(eth.key);
  report.add(e.status === "PRICED" && e.method === "CHAINLINK_ETH_USD" ? "PASS" : "FAIL", "ETH price", `${e.priceUsdDisplay} (${e.freshnessStatus}, age ${e.ageSeconds}s)`);
  const u = q(usdg.key);
  report.add(u.status === "PRICED" && u.method === "CHAINLINK_USDG_USD" ? "PASS" : "FAIL", "USDG price", `${u.priceUsdDisplay} (${u.freshnessStatus}), peg deviation ${u.pegDeviationBps?.toFixed(1)} bps`);
  const n = q(nvda.key);
  report.add(n.status === "PRICED" && n.method === "CHAINLINK_STOCK_TOKEN_FEED" && !n.crossCheck?.conflict ? "PASS" : n.status === "PRICED" ? "WARN" : "FAIL", "NVDA Chainlink price", `${n.priceUsdDisplay} (${n.freshnessStatus}); cross-check ${n.crossCheck?.performed ? n.crossCheck.percentageDifference?.toFixed(3) + "%" : n.crossCheck?.reason}`);
  const f = q(noFeed.key);
  report.add(f.status === "PRICED" && f.method === "ROBINHOOD_QUOTE_MID" ? "PASS" : "FAIL", `${noFeed.symbol} Robinhood fallback`, `${f.priceUsdDisplay} = mid × uiMultiplier; bid ${f.robinhoodQuote?.bid} ask ${f.robinhoodQuote?.ask}, spread ${f.robinhoodQuote?.spreadBps?.toFixed(1)} bps (${f.robinhoodQuote?.freshness})`);

  // ---- Portfolio Engine on real wallets ----
  const configured = (process.env.PORTFOLIO_TEST_WALLETS ?? "").split(",").map((x) => x.trim()).filter(Boolean) as Address[];
  let wallets = configured;
  let discovered = false;
  if (wallets.length < 2) {
    // One recent NVDA recipient (Stock Token wallet) + recent USDG recipients, scanned until one
    // holding only standard assets (ETH/WETH/USDG) is found. Bounded to keep RPC use low.
    const stockHolders = await discoverHolders(rt.rpc.url, NVDA, 1);
    const usdgHolders = await discoverHolders(rt.rpc.url, CORE_ASSETS.USDG.address, 8);
    wallets = [...stockHolders, ...usdgHolders.filter((h) => !stockHolders.includes(h))];
    discovered = true;
    report.info("test wallets", `discovered ${wallets.length} recent public holders (addresses redacted)`);
  }
  let sawStock = false;
  let sawStandardOnly = false;
  for (const w of wallets) {
    if (discovered && sawStock && sawStandardOnly) break;
    const p = await rt.getPortfolio(w);
    const problems = checkConsistency(p);
    const stocks = p.assets.filter((a) => a.asset.type === "STOCK_TOKEN").length;
    const standard = p.assets.length - stocks;
    if (stocks > 0) sawStock = true;
    if (stocks === 0 && standard > 0) sawStandardOnly = true;
    const detail =
      `${redact(w)}: ${p.assets.length} held (${stocks} Stock Tokens), priced ${p.valuationCoverage.pricedAssets}, unpriced ${p.valuationCoverage.unpricedAssets}, ` +
      `coverage ${p.valuationCoverage.coverageStatus}; ${p.timingsMs.total} ms (registry ${p.timingsMs.registry}, balances ${p.timingsMs.balances}, prices ${p.timingsMs.prices}, normalize ${p.timingsMs.normalization})`;
    const warningCodes = [...new Set(p.warnings.concat(p.assets.flatMap((a) => a.warnings)).map((x) => x.code))];
    report.add(problems.length ? "FAIL" : "PASS", "portfolio engine", detail, { wallet: redact(w), problems, warningCodes, timingsMs: p.timingsMs, rpc: p.rpc });
  }
  if (!sawStock) report.warn("wallet coverage", "no tested wallet held Stock Tokens");
  if (!sawStandardOnly) report.info("wallet coverage", "no tested wallet held only standard assets (ETH/WETH/USDG)");
  report.info("rpc health", JSON.stringify(rt.reader.health()));
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const r = await validatePortfolio();
  process.exitCode = r.finish();
}
