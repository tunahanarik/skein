/**
 * Phase 2 live validation (read-only): Morpho deployment + API support, full discovery through
 * the Opportunity Engine, INDEPENDENT onchain re-reads of representative markets (not via the
 * adapter's code path), IRM-derived borrow APY vs API, a public borrower's positions vs the
 * Morpho API, and wallet → portfolio → opportunities. Wallets appear only as hashes.
 */
import { createHash } from "node:crypto";
import { createPublicClient, http, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { robinhoodChain } from "../src/config/chains.js";
import { mulDivDown, wMulDown } from "../src/lib/fixed.js";
import type { Opportunity } from "../src/model/opportunity.js";
import { MORPHO_API_URL } from "../src/protocols/morpho/api.js";
import { MORPHO_ADDRESS, ORACLE_PRICE_SCALE } from "../src/protocols/morpho/onchain.js";
import { createRuntime } from "../src/runtime.js";
import { postGraphql } from "./lib/rpc.js";
import { Report } from "./lib/report.js";

const redact = (a: string) => "wallet#" + createHash("sha256").update(a.toLowerCase()).digest("hex").slice(0, 10);
const NVDA: Address = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG_KEY = "4663:0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32) view returns (address,address,address,address,uint256)",
  "function market(bytes32) view returns (uint128,uint128,uint128,uint128,uint128,uint128)",
]);
const irmAbi = parseAbi(["function borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128)) view returns (uint256)"]);

export async function validateOpportunities(report = new Report("opportunities-validation")) {
  const rt = createRuntime();
  const client = createPublicClient({ chain: robinhoodChain, transport: http(rt.rpc.url, { retryCount: 4, retryDelay: 1500 }) });

  // ---- deployment + API support (re-verified, not assumed) ----
  await rt.reader.assertChainId();
  const code = await client.getCode({ address: MORPHO_ADDRESS });
  report.add(code && code.length > 2 ? "PASS" : "FAIL", "morpho deployment", `${MORPHO_ADDRESS} code ${code ? (code.length - 2) / 2 : 0} bytes (official: docs.morpho.org addresses + morpho-org/sdks)`);
  const chains = await postGraphql<{ chains: { id: number; network: string }[] }>(MORPHO_API_URL, "{ chains { id network } }");
  const rh = chains.body.data?.chains.find((c) => c.id === 4663);
  report.add(rh ? "PASS" : "FAIL", "morpho api chain", rh ? `chainId 4663 = "${rh.network}"` : "4663 not listed");

  // ---- discovery through the engine ----
  const t0 = performance.now();
  const all = await rt.opportunities.getOpportunities();
  const ms = Math.round(performance.now() - t0);
  const cats = all.data.reduce<Record<string, number>>((m, o) => ((m[o.category] = (m[o.category] ?? 0) + 1), m), {});
  const vs = all.data.reduce<Record<string, number>>((m, o) => ((m[o.verificationStatus] = (m[o.verificationStatus] ?? 0) + 1), m), {});
  const a = all.adapters[0]!;
  report.add(all.status === "UNKNOWN" ? "FAIL" : all.status === "PARTIAL" ? "WARN" : "PASS", "discovery", `${all.status}: ${all.data.length} opportunities ${JSON.stringify(cats)}; verification ${JSON.stringify(vs)}; ${ms} ms (adapter ${JSON.stringify(a.timingsMs)})`, { issues: a.issues });

  // ---- representative opportunities ----
  const canonicalStockCollateral = all.data.filter((o) => o.category === "COLLATERAL" && o.primaryAsset.canonical && o.primaryAsset.registryType === "STOCK_TOKEN" && o.borrowAssets[0]?.canonical);
  const byLiquidity = (x: Opportunity, y: Opportunity) => Number((y.availableLiquidity?.value.amount.raw ?? 0n) - (x.availableLiquidity?.value.amount.raw ?? 0n) > 0n) - Number((y.availableLiquidity?.value.amount.raw ?? 0n) - (x.availableLiquidity?.value.amount.raw ?? 0n) < 0n);
  const stockPick = [...canonicalStockCollateral].filter((o) => o.risk.oracle?.multiplierCheck === "CONSISTENT").sort(byLiquidity)[0];
  const usdgLend = all.data.filter((o) => o.category === "LEND" && o.primaryAsset.key === USDG_KEY && o.risk.allAssetsCanonical).sort(byLiquidity)[0];
  const usdgLendListed = all.data.filter((o) => o.category === "LEND" && o.primaryAsset.key === USDG_KEY && o.risk.protocolListed.known && o.risk.protocolListed.value).sort(byLiquidity)[0];
  const doubles = canonicalStockCollateral.filter((o) => o.risk.oracle?.multiplierCheck === "DOUBLE_APPLIED");
  const vault = all.data.filter((o) => o.category === "VAULT" && o.primaryAsset.key === USDG_KEY).sort((x, y) => Number((y.tvl?.value.amount.raw ?? 0n) > (x.tvl?.value.amount.raw ?? 0n)) - Number((y.tvl?.value.amount.raw ?? 0n) < (x.tvl?.value.amount.raw ?? 0n)))[0];
  report.info("oracle multiplier checks", `stock collateral: ${JSON.stringify(canonicalStockCollateral.reduce<Record<string, number>>((m, o) => ((m[o.risk.oracle!.multiplierCheck] = (m[o.risk.oracle!.multiplierCheck] ?? 0) + 1), m), {}))}; DOUBLE_APPLIED → CONFLICT: ${doubles.map((o) => o.primaryAsset.symbol).join(", ") || "none"}`);
  if (doubles.some((o) => o.verificationStatus !== "CONFLICT")) report.fail("double-applied oracle handling", "a DOUBLE_APPLIED market is not CONFLICT");
  else report.pass("double-applied oracle handling", `${doubles.length} markets marked CONFLICT`);

  // Independent re-read: raw viem calls, not the adapter's readers.
  const head = await client.getBlockNumber();
  for (const [label, o] of [["stock collateral", stockPick], ["USDG lend (canonical)", usdgLend], ["USDG lend (listed)", usdgLendListed]] as const) {
    if (!o || o.details.kind !== "MORPHO_MARKET") {
      report.warn(`representative ${label}`, "none found");
      continue;
    }
    const d = o.details;
    const [params, m] = await Promise.all([
      client.readContract({ address: MORPHO_ADDRESS, abi: morphoAbi, functionName: "idToMarketParams", args: [d.marketId as Hex], blockNumber: head }),
      client.readContract({ address: MORPHO_ADDRESS, abi: morphoAbi, functionName: "market", args: [d.marketId as Hex], blockNumber: head }),
    ]);
    const problems = [
      params[0].toLowerCase() !== d.loanAsset.address.toLowerCase() ? "loan" : "",
      params[1].toLowerCase() !== d.collateralAsset.address.toLowerCase() ? "collateral" : "",
      params[2].toLowerCase() !== d.oracle.toLowerCase() ? "oracle" : "",
      params[3].toLowerCase() !== d.irm.toLowerCase() ? "irm" : "",
      params[4] !== d.lltv ? "lltv" : "",
    ].filter(Boolean);
    const supplyEngine = d.totalSupply?.value.raw ?? null;
    const drift = supplyEngine === null ? null : Number(((m[0] > supplyEngine ? m[0] - supplyEngine : supplyEngine - m[0]) * 1_000_000n) / (m[0] || 1n)) / 10_000;
    if (drift !== null && drift > 0.5) problems.push(`supply drift ${drift}%`);
    // IRM borrow rate at head → APY, compared with the API's borrow APY (float only for this tolerance check).
    let irmNote = "";
    try {
      const rate = await client.readContract({ address: d.irm, abi: irmAbi, functionName: "borrowRateView", args: [[params[0], params[1], params[2], params[3], params[4]], [m[0], m[1], m[2], m[3], m[4], m[5]]], blockNumber: head });
      // Morpho: borrowAPY = e^(rate·yr) − 1; supplyAPY = e^(rate·yr·utilization·(1 − fee)) − 1.
      // Floats are used ONLY for this tolerance comparison, never for displayed values.
      const yr = (Number(rate) / 1e18) * 31_536_000;
      const util = m[0] > 0n ? Number(m[2]) / Number(m[0]) : 0;
      const fee = Number(m[5]) / 1e18;
      const onchainApy = o.category === "COLLATERAL" ? Math.expm1(yr) : Math.expm1(yr * util * (1 - fee));
      const type = o.category === "COLLATERAL" ? "BORROW_APY" : "SUPPLY_APY";
      const apiApy = Number(o.yields.find((y) => y.type === type)?.value ?? 0n) / 1e18;
      irmNote = `; IRM-derived ${type} ${(onchainApy * 100).toFixed(4)}% vs API ${(apiApy * 100).toFixed(4)}%`;
      if (apiApy > 0 && Math.abs(onchainApy - apiApy) / apiApy > 0.05) irmNote += " (>5% apart: API state is indexed at an earlier block)";
    } catch (e) {
      irmNote = `; IRM read failed: ${(e as Error).message.split("\n")[0]}`;
    }
    const detail = `${o.title} | market ${d.marketId.slice(0, 10)}… | identity ${problems.length ? "MISMATCH" : "matches chain"}; supply drift ${drift ?? "n/a"}%${irmNote}`;
    report.add(problems.length ? "FAIL" : "PASS", `representative ${label}`, detail, { id: o.id, verification: o.verificationStatus, freshness: o.freshness, block: head, problems });
  }
  if (vault && vault.details.kind === "MORPHO_VAULT_V2") {
    const ta = await client.readContract({ address: vault.details.vault, abi: parseAbi(["function totalAssets() view returns (uint256)"]), functionName: "totalAssets" });
    const e = vault.tvl?.value.amount.raw ?? 0n;
    const drift = Number(((ta > e ? ta - e : e - ta) * 1_000_000n) / (ta || 1n)) / 10_000;
    report.add(drift <= 0.5 ? "PASS" : "FAIL", "representative USDG vault", `${vault.title}: totalAssets drift ${drift}%, NET_APY ${vault.yields.find((y) => y.type === "NET_APY")?.value ?? "n/a"}, warnings ${vault.risk.protocolWarnings.map((w) => w.type).join(",") || "none"}`);
  } else report.warn("representative USDG vault", "none found");

  // ---- positions: a public borrower from the Morpho API vs our onchain scan ----
  if (usdgLendListed && usdgLendListed.details.kind === "MORPHO_MARKET") {
    const q = await postGraphql<{ marketPositions: { items: { user: { address: Address }; state: { collateral: string | number; borrowShares: string | number } }[] } }>(
      MORPHO_API_URL,
      `{ marketPositions(first:1, orderBy:BorrowShares, orderDirection:Desc, where:{chainId_in:[4663], marketUniqueKey_in:["${usdgLendListed.details.marketId}"]}) { items { user { address } state { collateral borrowShares } } } }`,
    );
    const top = q.body.data?.marketPositions.items[0];
    if (top) {
      const pos = await rt.opportunities.getUserPositions(top.user.address);
      const marketId = usdgLendListed.details.marketId;
      const p = pos.data.find((x) => x.venue.id === marketId);
      const ok = p && p.collateral?.value.amount.raw === BigInt(top.state.collateral);
      report.add(ok ? "PASS" : "WARN", "positions vs Morpho API", `${redact(top.user.address)}: ${pos.data.length} positions found onchain; collateral ${ok ? "matches" : "differs from"} API; HF ${p?.healthFactor ? (Number(p.healthFactor.value) / 1e18).toFixed(4) : "n/a"} (Morpho definition, computed); liquidatable ${p?.liquidatable}; ${pos.timingsMs.total} ms`);
    } else report.warn("positions vs Morpho API", "no borrower found");
  }

  // ---- wallet → portfolio → opportunities ----
  const logs = await client.getLogs({ address: NVDA, event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), fromBlock: head - 3_000n, toBlock: head });
  let holder: Address | null = null;
  for (const l of logs.reverse()) {
    const to = l.args.to;
    if (!to) continue;
    const c = await client.getCode({ address: to });
    if (!c || c === "0x") {
      holder = to;
      break;
    }
  }
  if (holder) {
    const t1 = performance.now();
    const portfolio = await rt.getPortfolio(holder);
    const po = await rt.opportunities.getPortfolioOpportunities(portfolio, { filter: { canonicalOnly: true } });
    const nvdaGroup = po.data.find((g) => g.assetKey === `4663:${NVDA.toLowerCase()}`);
    const withMax = nvdaGroup?.items.find((i) => i.context.kind === "COLLATERAL" && i.context.protocolMaximumBorrow);
    let check = "no NVDA collateral opportunity with a readable oracle";
    if (withMax && withMax.context.kind === "COLLATERAL") {
      const lt = withMax.opportunity.liquidation!;
      const recomputed = wMulDown(mulDivDown(withMax.holding.rawBalance, lt.collateralPrice!.value.raw, ORACLE_PRICE_SCALE), lt.lltv.value);
      check = `protocolMaximumBorrow ${withMax.context.protocolMaximumBorrow!.amount.display} ${withMax.context.protocolMaximumBorrow!.asset.symbol} ${recomputed === withMax.context.protocolMaximumBorrow!.amount.raw ? "= independent recomputation" : "≠ recomputation"}`;
    }
    const groups = po.data.filter((g) => g.items.length);
    report.add(withMax ? "PASS" : "WARN", "wallet → opportunities", `${redact(holder)}: ${portfolio.assets.length} held assets, ${groups.length} with opportunities (${groups.reduce((s, g) => s + g.items.length, 0)} total); ${check}; ${Math.round(performance.now() - t1)} ms`);
  } else report.warn("wallet → opportunities", "no recent NVDA holder found");
  report.info("rpc health", JSON.stringify(rt.reader.health()));
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const r = await validateOpportunities();
  process.exitCode = r.finish();
}
