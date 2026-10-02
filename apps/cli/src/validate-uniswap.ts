/**
 * Phase 4 live validation (read-only): Uniswap deployment identity vs the official registry,
 * pool discovery vs an INDEPENDENT factory log scan, representative pools re-read with raw viem
 * calls at the adapter's block (a Stock Token pool, a USDG pool, a structurally different pool),
 * price/TVL/fee/state, DIRECT and ONE_HOP routes, an INDICATIVE quote re-derived independently,
 * performance, and a combined Morpho + Pendle + Uniswap view. No wallet data is printed.
 */
import { createPublicClient, getAddress, http, parseAbi, type Address } from "viem";
import { robinhoodChain } from "@skein/networks/chains";
import { formatFixed18, formatPercent } from "@skein/core/lib/fixed";
import type { Opportunity } from "@skein/core/model/opportunity";
import type { TradeMarket } from "@skein/core/model/trade";
import { poolCreatedEvent, quoterV2Abi, UNISWAP_DEPLOYMENT_SOURCE, UNISWAP_READ_CONTRACTS, UNISWAP_RECORDED_ONLY } from "@skein/protocols/uniswap/constants";
import { price0In1 } from "@skein/protocols/uniswap/math";
import { createRuntime, type Runtime } from "@skein/runtime/runtime";
import { getJson } from "./lib/rpc.js";
import { Report } from "./lib/report.js";

const NVDA: Address = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec";
const USDG: Address = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const WETH: Address = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const K = (a: string) => `4663:${a.toLowerCase()}`;
const pool = parseAbi(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)", "function liquidity() view returns (uint128)", "function fee() view returns (uint24)", "function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)"]);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const usdOf = (m: TradeMarket) => (m.liquidity.tvl ? Number(m.liquidity.tvl.value.e18 / 10n ** 12n) / 1e6 : null);

let shared: Runtime | null = null;
const runtime = () => (shared ??= createRuntime());

export async function validateUniswap(report = new Report("uniswap-validation")) {
  const rt = runtime();
  const client = createPublicClient({ chain: robinhoodChain, transport: http(rt.rpc.url, { retryCount: 4, retryDelay: 1500 }) });
  await rt.reader.assertChainId();

  // ---- deployment identity: official registry == our constants == live code ----
  const reg = await getJson<{ latest: Record<string, { address: string }> }>("https://raw.githubusercontent.com/Uniswap/contracts/main/deployments/json/4663.json");
  const official = new Set(Object.values(reg.body.latest ?? {}).map((v) => v.address.toLowerCase()));
  const ours = { ...UNISWAP_READ_CONTRACTS, ...UNISWAP_RECORDED_ONLY };
  const notOfficial = Object.entries(ours).filter(([, a]) => !official.has(a.toLowerCase()));
  report.add(notOfficial.length ? "FAIL" : "PASS", "deployment registry", `${Object.keys(ours).length} addresses, all in ${UNISWAP_DEPLOYMENT_SOURCE}${notOfficial.length ? `; NOT official: ${notOfficial.map(([k]) => k).join(", ")}` : ""}`);
  for (const [k, a] of Object.entries(UNISWAP_READ_CONTRACTS)) {
    const code = await client.getCode({ address: a });
    report.add(code && code.length > 2 ? "PASS" : "FAIL", `code ${k}`, `${getAddress(a)} ${code ? (code.length - 2) / 2 : 0} bytes`);
  }

  // ---- discovery through the engine (cold, then warm) ----
  let t = performance.now();
  const markets = await rt.opportunities.getTradeMarkets();
  const coldMs = Math.round(performance.now() - t);
  const ad = markets.adapters.find((a) => a.protocol === "uniswap")!;
  t = performance.now();
  await rt.opportunities.getTradeMarkets();
  const warmMs = Math.round(performance.now() - t);
  const ms = markets.data;
  const canon = ms.filter((m) => m.assets[0].canonical && m.assets[1].canonical);
  const states = ms.reduce<Record<string, number>>((a, m) => ((a[m.state] = (a[m.state] ?? 0) + 1), a), {});
  report.add(ad.status === "UNKNOWN" ? "FAIL" : ad.status === "PARTIAL" ? "WARN" : "PASS", "pool discovery", `${ad.status}: ${ms.length} pools indexed (${canon.length} both-canonical); states ${JSON.stringify(states)}; cold ${coldMs} ms (${JSON.stringify(ad.timingsMs)}), warm ${warmMs} ms`, { issues: ad.issues.slice(0, 10) });

  // independent cross-check for NVDA: raw log queries without the adapter
  const block = markets.blockNumber;
  const [l0, l1] = await Promise.all([
    client.getLogs({ address: UNISWAP_READ_CONTRACTS.v3Factory, event: poolCreatedEvent, args: { token0: NVDA }, fromBlock: 0n, toBlock: block }),
    client.getLogs({ address: UNISWAP_READ_CONTRACTS.v3Factory, event: poolCreatedEvent, args: { token1: NVDA }, fromBlock: 0n, toBlock: block }),
  ]);
  const indep = new Set([...l0, ...l1].map((l) => l.args.pool!.toLowerCase()));
  const ourNvda = new Set(ms.filter((m) => m.assets.some((a) => a.key === K(NVDA))).map((m) => m.marketId));
  const missing = [...indep].filter((p) => !ourNvda.has(p));
  report.add(missing.length ? "FAIL" : "PASS", "discovery = independent NVDA log scan", `${indep.size} NVDA pools in factory logs; ${ourNvda.size} indexed; missing ${missing.length}`);

  // ---- representative pools, re-read independently at the same block ----
  const byTvl = (xs: TradeMarket[]) => [...xs].sort((a, b) => (usdOf(b) ?? -1) - (usdOf(a) ?? -1));
  const stockPool = byTvl(canon.filter((m) => m.assets.some((a) => a.registryType === "STOCK_TOKEN") && m.state === "ACTIVE"))[0];
  const usdgPool = byTvl(canon.filter((m) => m.assets.some((a) => a.key === K(USDG)) && m.assets.every((a) => a.registryType !== "STOCK_TOKEN") && m.state === "ACTIVE"))[0];
  const different = byTvl(canon.filter((m) => m !== stockPool && m.fee?.value.ppm !== stockPool?.fee?.value.ppm && m.assets.some((a) => a.registryType === "STOCK_TOKEN") && m.assets.some((a) => a.key === K(WETH))))[0] ?? byTvl(canon.filter((m) => m.fee?.value.ppm !== stockPool?.fee?.value.ppm))[0];
  for (const [label, m] of [["Stock Token pool", stockPool], ["USDG pool", usdgPool], ["structurally different pool", different]] as const) {
    if (!m || !m.address) {
      report.warn(label, "none found");
      continue;
    }
    const at = { blockNumber: block };
    const [s0, liq, fee, fac, t0, t1, b0, b1] = await Promise.all([
      client.readContract({ address: m.address, abi: pool, functionName: "slot0", ...at }),
      client.readContract({ address: m.address, abi: pool, functionName: "liquidity", ...at }),
      client.readContract({ address: m.address, abi: pool, functionName: "fee", ...at }),
      client.readContract({ address: m.address, abi: pool, functionName: "factory", ...at }),
      client.readContract({ address: m.address, abi: pool, functionName: "token0", ...at }),
      client.readContract({ address: m.address, abi: pool, functionName: "token1", ...at }),
      client.readContract({ address: m.assets[0].address, abi: erc, functionName: "balanceOf", args: [m.address], ...at }),
      client.readContract({ address: m.assets[1].address, abi: erc, functionName: "balanceOf", args: [m.address], ...at }),
    ]);
    const idOk = getAddress(fac) === getAddress(UNISWAP_READ_CONTRACTS.v3Factory) && getAddress(t0) === getAddress(m.assets[0].address) && getAddress(t1) === getAddress(m.assets[1].address) && Number(fee) === m.fee?.value.ppm;
    report.add(idOk && m.originVerified ? "PASS" : "FAIL", `${label}: identity`, `${m.assets.map((a) => a.symbol).join("/")} ${m.marketId.slice(0, 12)}… fee ${fee} ppm; factory/token0/token1/fee re-read ${idOk ? "match" : "DIFFER"}; origin ${m.originVerified ? "verified" : "NOT verified"}`);
    const p = price0In1(s0[0], m.assets[0].decimals, m.assets[1].decimals);
    const priceOk = p === m.price?.value.value;
    const resOk = m.liquidity.reserves[0]?.value.amount?.raw === b0 && m.liquidity.reserves[1]?.value.amount?.raw === b1 && m.liquidity.activeLiquidity?.value === liq;
    const div = m.warnings.find((w) => w.code === "MARKET_PRICE_DIVERGENCE");
    report.add(priceOk && resOk ? "PASS" : "FAIL", `${label}: state`, `price 1 ${m.assets[0].symbol} = ${formatFixed18(p)} ${m.assets[1].symbol} (${priceOk ? "=" : "≠"}); reserves/L ${resOk ? "match" : "DIFFER"}; TVL $${usdOf(m)?.toFixed(0) ?? "unknown"}; divergence vs portfolio: ${div ? div.message.slice(0, 120) : "none (< 2%)"}`);
  }

  // ---- stock token and USDG pool inventory (actual findings) ----
  for (const sym of ["NVDA", "AAPL", "MSFT", "GOOGL", "TSLA"]) {
    const a = (await rt.getRegistry()).canonicalBySymbol(sym)[0];
    if (!a) continue;
    const ps = byTvl(canon.filter((m) => m.assets.some((x) => x.key === a.key)));
    report.info(`${sym} pools`, ps.length ? ps.slice(0, 6).map((m) => `${m.assets.map((x) => x.symbol).join("/")} ${(m.fee?.value.ppm ?? 0) / 10_000}% ${m.state} $${usdOf(m)?.toFixed(0) ?? "?"}`).join("; ") : "no v3 pool with a canonical counterpart");
  }
  const usdgPools = canon.filter((m) => m.assets.some((a) => a.key === K(USDG)));
  const usdgActive = usdgPools.filter((m) => m.state === "ACTIVE" && (usdOf(m) ?? 0) >= 50);
  const counterparts = new Set(usdgActive.map((m) => m.assets.find((a) => a.key !== K(USDG))!.symbol));
  report.info("USDG pools", `${usdgPools.length} both-canonical USDG pools; ${usdgActive.length} active and ≥ $50 TVL; ${counterparts.size} distinct counterparts`);

  // ---- routes and quote ----
  t = performance.now();
  const routes = await rt.opportunities.getTradeRoutes(K(NVDA), K(USDG));
  const routeMs = Math.round(performance.now() - t);
  report.add(routes.data.direct.length ? "PASS" : "WARN", "DIRECT route NVDA→USDG", `${routes.data.direct.length} direct, ${routes.data.oneHop.length} one-hop; graph ${routes.data.edges} edges built in ${routes.data.graphMs} ms; lookup ${routeMs} ms (incl. market snapshot)`);
  const oneHop = routes.data.oneHop[0];
  report.add(oneHop ? "PASS" : "INFO", "ONE_HOP route", oneHop ? `${[oneHop.input, ...oneHop.intermediates, oneHop.output].map((a) => a.symbol).join(" → ")}, bottleneck TVL $${oneHop.properties.bottleneckTvlUsd?.display.slice(0, 12) ?? "?"}, fee ${oneHop.properties.combinedFeePpm} ppm` : "topology has no one-hop route through USDG/WETH for NVDA→USDG");
  const direct = routes.data.direct[0];
  if (direct) {
    const amount = 10n ** 18n; // 1 NVDA
    t = performance.now();
    const q = await rt.opportunities.getTradeQuote(direct, amount);
    const qMs = Math.round(performance.now() - t);
    if (q.ok) {
      const m = markets.data.find((x) => x.id === direct.hops[0]!.marketId)!;
      const indep = await client.simulateContract({ address: UNISWAP_READ_CONTRACTS.quoterV2, abi: quoterV2Abi, functionName: "quoteExactInputSingle", args: [{ tokenIn: NVDA, tokenOut: USDG, amountIn: amount, fee: m.fee!.value.ppm!, sqrtPriceLimitX96: 0n }], blockNumber: q.quote.blockNumber });
      const same = indep.result[0] === q.quote.expectedOutput.raw;
      report.add(same ? "PASS" : "FAIL", "INDICATIVE quote 1 NVDA→USDG", `${q.quote.expectedOutput.display} USDG (independent eth_call ${same ? "identical" : "DIFFERS"}); impact ${q.quote.priceImpact === null ? "n/a" : formatPercent(q.quote.priceImpact, 4)}; fee ${q.quote.fees?.[0]?.amount.display} NVDA; gas est ${q.quote.gasEstimate}; ${qMs} ms`);
      const big = await rt.opportunities.getTradeQuote(direct, 1_000n * 10n ** 18n);
      report.info("INDICATIVE quote 1,000 NVDA→USDG", big.ok ? `${big.quote.expectedOutput.display} USDG; impact ${big.quote.priceImpact === null ? "n/a" : formatPercent(big.quote.priceImpact, 4)}` : `unavailable: ${big.reason}`);
      if (oneHop) {
        const q2 = await rt.opportunities.getTradeQuote(oneHop, amount);
        report.info("INDICATIVE quote one-hop 1 NVDA", q2.ok ? `${q2.quote.expectedOutput.display} USDG via ${oneHop.intermediates.map((a) => a.symbol).join()}; impact ${q2.quote.priceImpact === null ? "n/a" : formatPercent(q2.quote.priceImpact, 4)}` : `unavailable: ${q2.reason}`);
      }
    } else report.fail("INDICATIVE quote", q.reason);
  }
  report.info("performance", `cold discovery ${coldMs} ms; warm ${warmMs} ms; route lookup ${routeMs} ms`);
  return report;
}

export async function validateCombinedTrade(report = new Report("combined-trade-validation")) {
  const rt = runtime();
  const t = performance.now();
  const r = await rt.opportunities.getAssetOpportunities(K(NVDA));
  const ms = Math.round(performance.now() - t);
  const by = r.data.reduce<Record<string, number>>((a, o) => ((a[`${o.protocol.id}:${o.category}`] = (a[`${o.protocol.id}:${o.category}`] ?? 0) + 1), a), {});
  const protos = new Set(r.data.map((o: Opportunity) => o.protocol.id));
  report.add(["morpho", "pendle", "uniswap"].every((p) => protos.has(p)) ? "PASS" : "WARN", "NVDA: Morpho + Pendle + Uniswap", `${r.status}; ${JSON.stringify(by)}; ${ms} ms; adapters ${JSON.stringify(Object.fromEntries(r.adapters.map((a) => [a.protocol, a.status])))}`);
  const all = await rt.opportunities.getOpportunities();
  report.add(all.status === "UNKNOWN" ? "FAIL" : all.status === "PARTIAL" ? "WARN" : "PASS", "all opportunities (default view)", `${all.status}; ${all.data.length} shown; hidden ${JSON.stringify(all.excluded?.byReason ?? {})}`);
  const ids = all.data.map((o) => o.id);
  report.add(new Set(ids).size === ids.length ? "PASS" : "FAIL", "unique ids", `${ids.length}`);
  const y = await rt.opportunities.getOpportunities({ sort: { by: "YIELD", yieldType: "SUPPLY_APY", direction: "DESC" } });
  const ranked = y.data.slice(0, y.data.length - (y.notComparable?.length ?? 0));
  report.add(ranked.some((o) => o.category === "TRADE") ? "FAIL" : "PASS", "TRADE never ranked by APY", `${ranked.length} ranked by SUPPLY_APY, none TRADE`);
  report.info("rpc health", JSON.stringify(rt.reader.health()));
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const a = await validateUniswap();
  const ea = a.finish();
  console.log("\n=== combined (Morpho + Pendle + Uniswap) ===");
  const b = await validateCombinedTrade();
  process.exitCode = ea || b.finish();
}
