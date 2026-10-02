/**
 * Phase 3 live validation (read-only): Pendle deployment, onchain discovery vs an independent log
 * scan, representative markets re-read INDEPENDENTLY (raw viem calls at the adapter's block, not
 * the adapter's code path) — a USDG market, a Stock Token market and a structurally different
 * (expired) market — plus API cross-checks, eligibility, positions and performance.
 * `validateCombined` checks Morpho + Pendle through one engine. Wallets appear only as hashes.
 */
import { createHash } from "node:crypto";
import { createPublicClient, getAddress, http, parseAbi, parseAbiItem, type Address } from "viem";
import { robinhoodChain } from "@skein/networks/chains";
import { mulDivDown } from "@skein/core/lib/fixed";
import type { Opportunity } from "@skein/core/model/opportunity";
import { PENDLE_API_BASE } from "@skein/protocols/pendle/api";
import { createNewMarketEvent, PENDLE_CONTRACTS } from "@skein/protocols/pendle/constants";
import { createRuntime, type Runtime } from "@skein/runtime/runtime";
import { getJson } from "./lib/rpc.js";
import { Report } from "./lib/report.js";

const redact = (a: string) => "wallet#" + createHash("sha256").update(a.toLowerCase()).digest("hex").slice(0, 10);
const USDG: Address = "0x5fc5360D0400a0fd4F2aF552aDD042D716F1D168";
const mk = parseAbi([
  "function readTokens() view returns (address,address,address)",
  "function expiry() view returns (uint256)",
  "function _storage() view returns (int128,int128,uint96,uint16,uint16,uint16)",
]);
const sy = parseAbi(["function exchangeRate() view returns (uint256)", "function yieldToken() view returns (address)"]);
const rs = parseAbi(["function getPtToAssetRate(address) view returns (uint256)"]);
const mult = parseAbi(["function uiMultiplier() view returns (uint256)"]);
const bal = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const pct = (a: number, b: number) => (Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-18)) * 100;
const n18 = (v: bigint) => Number(v) / 1e18;

let shared: Runtime | null = null;
const runtime = () => (shared ??= createRuntime());

export async function validatePendleAdapter(report = new Report("pendle-adapter-validation")) {
  const rt = runtime();
  const client = createPublicClient({ chain: robinhoodChain, transport: http(rt.rpc.url, { retryCount: 4, retryDelay: 1500 }) });
  await rt.reader.assertChainId();

  // ---- deployment (official 4663-core.json addresses, re-verified live) ----
  for (const [name, a] of Object.entries(PENDLE_CONTRACTS)) {
    const code = await client.getCode({ address: a });
    report.add(code && code.length > 2 ? "PASS" : "FAIL", `deployment ${name}`, `${a} code ${code ? (code.length - 2) / 2 : 0} bytes`);
  }

  // ---- discovery: adapter vs independent full-range log scan ----
  const t0 = performance.now();
  const all = await rt.opportunities.getOpportunities({ eligibility: "ALL", filter: { protocols: ["pendle"] } });
  const coldMs = Math.round(performance.now() - t0);
  const ad = all.adapters.find((a) => a.protocol === "pendle")!;
  const block = all.blockNumber;
  const logs = await client.getLogs({ address: PENDLE_CONTRACTS.marketFactoryV6, event: createNewMarketEvent, fromBlock: 0n, toBlock: block });
  const indep = new Set(logs.map((l) => l.args.market!.toLowerCase()));
  const found = new Set(all.data.map((o) => o.venue.id));
  const missing = [...indep].filter((m) => !found.has(m));
  report.add(missing.length ? "FAIL" : "PASS", "discovery = factory logs", `${indep.size} CreateNewMarket logs, ${found.size} markets published; missing ${missing.length}; adapter ${ad.status} ${JSON.stringify(ad.timingsMs)}`, { issues: ad.issues });
  const listed = await getJson<{ results?: { address: string }[]; markets?: { address: string }[] }>(`${PENDLE_API_BASE}/v2/markets/all?chainId=4663`);
  const apiSet = new Set((listed.body.results ?? listed.body.markets ?? []).map((m) => m.address.toLowerCase().replace(/^4663-/, "")));
  const onlyOnchain = [...found].filter((m) => !apiSet.has(m));
  const onlyApi = [...apiSet].filter((m) => !found.has(m));
  report.add(onlyApi.length ? "FAIL" : "PASS", "API list ⊆ onchain discovery", `API lists ${apiSet.size}; found onchain but not in the API list: ${onlyOnchain.length} (${onlyOnchain.map((m) => m.slice(0, 10)).join(", ")}); API-only: ${onlyApi.length}`);

  // ---- representative markets, independent re-reads at the same block ----
  const pts = all.data.filter((o) => o.category === "FIXED_YIELD" && o.details.kind === "PENDLE_MARKET");
  const liq = (o: Opportunity) => o.availableLiquidity?.value.usd?.e18 ?? 0n;
  const pick = (f: (o: Opportunity) => boolean) => pts.filter(f).sort((a, b) => (liq(b) > liq(a) ? 1 : liq(b) < liq(a) ? -1 : 0))[0];
  const usdgM = pick((o) => o.lifecycle.state === "ACTIVE" && o.details.kind === "PENDLE_MARKET" && o.details.yieldToken.address.toLowerCase() === USDG.toLowerCase());
  const stockM = pick((o) => o.lifecycle.state === "ACTIVE" && o.primaryAsset.registryType === "STOCK_TOKEN");
  const otherM = pick((o) => o.lifecycle.state === "EXPIRED");
  for (const [label, o] of [["USDG", usdgM], ["Stock Token", stockM], ["structurally different (expired)", otherM]] as const) {
    if (!o || o.details.kind !== "PENDLE_MARKET") {
      report.warn(`market ${label}`, "no such market found");
      continue;
    }
    const d = o.details;
    const at = { blockNumber: block };
    const [tokens, expiry, st, rate, ptRate] = await Promise.all([
      client.readContract({ address: d.market, abi: mk, functionName: "readTokens", ...at }),
      client.readContract({ address: d.market, abi: mk, functionName: "expiry", ...at }),
      client.readContract({ address: d.market, abi: mk, functionName: "_storage", ...at }),
      client.readContract({ address: d.sy.address, abi: sy, functionName: "exchangeRate", ...at }),
      client.readContract({ address: PENDLE_CONTRACTS.routerStatic, abi: rs, functionName: "getPtToAssetRate", args: [d.market], ...at }),
    ]);
    const idOk = getAddress(tokens[0]) === getAddress(d.sy.address) && getAddress(tokens[1]) === getAddress(d.pt.address) && getAddress(tokens[2]) === getAddress(d.yt.address) && new Date(Number(expiry) * 1000).toISOString() === o.lifecycle.maturity?.value;
    report.add(idOk ? "PASS" : "FAIL", `market ${label}: identity`, `${d.market.slice(0, 10)}… ${d.pt.symbol}; SY/PT/YT/expiry re-read ${idOk ? "match" : "DIFFER"}; lifecycle ${o.lifecycle.state}; verification ${o.verificationStatus}; checks ${d.identityChecks.filter((c) => c.ok).length}/${d.identityChecks.length}`);
    const rateOk = rate === d.syExchangeRate?.value && ptRate === d.ptToAssetRate?.value;
    report.add(rateOk ? "PASS" : "FAIL", `market ${label}: rates`, `SY.exchangeRate ${n18(rate)} ${rate === d.syExchangeRate?.value ? "=" : "≠"}; ptToAssetRate ${n18(ptRate)} ${ptRate === d.ptToAssetRate?.value ? "=" : "≠"}; PT discount ${d.ptDiscount ? (n18(d.ptDiscount.value) * 100).toFixed(3) + "%" : "n/a"}`);
    const implied = o.yields.find((y) => y.type === "IMPLIED_APY");
    if (o.lifecycle.state === "EXPIRED") {
      report.add(!implied && o.lifecycle.canEnter === false && o.eligibility?.excludedBy.includes("EXPIRED") ? "PASS" : "FAIL", `market ${label}: expired handling`, `no yields published (${o.yields.length}); canEnter ${o.lifecycle.canEnter}; excluded by ${o.eligibility?.excludedBy.join(",")}`);
    } else if (implied) {
      const ref = Math.expm1(Number(st[2]) / 1e18);
      const e = pct(n18(implied.value), ref);
      const api = d.apiImpliedApy ? n18(d.apiImpliedApy.value) : null;
      report.add(e < 1e-9 ? "PASS" : "FAIL", `market ${label}: implied APY`, `onchain exp(lnRate)−1 = ${(ref * 100).toFixed(6)}%; adapter ${(n18(implied.value) * 100).toFixed(6)}% (Δ ${e.toExponential(1)}%); API ${api === null ? "n/a" : (api * 100).toFixed(6) + "% (Δ " + pct(api, ref).toExponential(1) + "%)"}`);
    } else report.fail(`market ${label}: implied APY`, "no IMPLIED_APY on an active market");
    if (label === "Stock Token") {
      const m = await client.readContract({ address: d.yieldToken.address, abi: mult, functionName: "uiMultiplier", ...at });
      report.add(m === rate ? "PASS" : "WARN", "stock SY rate = uiMultiplier", `${d.yieldToken.symbol}: SY.exchangeRate ${n18(rate)} ${m === rate ? "==" : "!="} uiMultiplier ${n18(m)} → accounting unit ${d.accountingUnit.assetType} (${d.accountingUnit.syRateEqualsMultiplier ? "share-equivalent" : "?"})`);
    }
    const onUsd = o.availableLiquidity?.value.usd ? n18(o.availableLiquidity.value.usd.e18) : null;
    const apiUsd = d.apiLiquidityUsd ? n18(d.apiLiquidityUsd.value.e18) : null;
    const syEq = st[1] + mulDivDown(st[0], ptRate, rate);
    report.add(onUsd !== null && apiUsd !== null && pct(onUsd, apiUsd) > 5 ? "WARN" : "PASS", `market ${label}: pool liquidity`, `onchain PT+SY = ${n18(syEq * 10n ** BigInt(18 - d.sy.decimals)).toFixed(4)} SY-equivalent; adapter ${o.availableLiquidity?.value.amount?.display ?? "?"} ${d.yieldToken.symbol} ($${onUsd?.toFixed(2) ?? "unpriced"}); API $${apiUsd?.toFixed(2) ?? "n/a"}${onUsd && apiUsd ? ` (Δ ${pct(onUsd, apiUsd).toFixed(2)}%)` : ""}`);
    report.info(`market ${label}: semantics`, `yields ${o.yields.map((y) => y.type).join(",") || "none"}; entry ${o.entry.kind} [${o.entry.steps.map((s) => `${s.action}:${s.verified}`).join(" ")}]; listed ${o.risk.protocolListed.known ? o.risk.protocolListed.value : "unknown"}; eligible ${o.eligibility?.eligibleForDefaultDisplay} ${o.eligibility?.excludedBy.join(",") ?? ""}; advisories ${o.eligibility?.advisories.join(",") ?? ""}; warnings ${[...new Set(o.warnings.map((w) => w.code))].join(",")}`);
  }

  // ---- default eligibility for Pendle ----
  const def = await rt.opportunities.getOpportunities({ filter: { protocols: ["pendle"] } });
  const bad = def.data.filter((o) => o.lifecycle.state !== "ACTIVE" || !o.risk.allAssetsCanonical || o.verificationStatus === "CONFLICT");
  report.add(bad.length ? "FAIL" : "PASS", "default eligibility (Pendle)", `${def.data.length} shown of ${all.data.length}; hidden ${JSON.stringify(def.excluded?.byReason ?? {})}; expired/non-canonical/conflicted shown: ${bad.length}`);
  const semantics = def.data.every((o) => (o.category === "YIELD" ? !o.yields.some((y) => y.type === "IMPLIED_APY") : true) && !o.yields.some((y) => y.type === "FIXED_APY"));
  report.add(semantics ? "PASS" : "FAIL", "yield semantics", "no FIXED_APY claimed; YT carries no IMPLIED_APY; PT headline is IMPLIED_APY (market rate, not guaranteed)");

  // ---- positions: a recent PT holder (EOA), value re-derived independently ----
  {
    // Scan PT transfers of the active canonical markets from their creation block; first EOA holder wins.
    let holder: Address | null = null;
    let d: Extract<Opportunity["details"], { kind: "PENDLE_MARKET" }> | null = null;
    const candidates = [usdgM, stockM, ...pts.filter((o) => o.lifecycle.state === "ACTIVE" && o.risk.allAssetsCanonical)].filter((o): o is Opportunity => !!o);
    const tlogs: { args: { to?: Address | undefined }; pt: Extract<Opportunity["details"], { kind: "PENDLE_MARKET" }> }[] = [];
    for (const o of candidates) {
      if (o.details.kind !== "PENDLE_MARKET") continue;
      const det = o.details;
      const l = await client.getLogs({ address: det.pt.address, event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"), fromBlock: det.createdAtBlock, toBlock: block });
      tlogs.push(...l.map((x) => ({ args: x.args, pt: det })).reverse());
      if (tlogs.length > 50) break;
    }
    for (const l of tlogs) {
      const to = l.args.to;
      if (!to || /^0x0{40}$/i.test(to)) continue;
      const code = await client.getCode({ address: to });
      if ((!code || code === "0x") && (await client.readContract({ address: l.pt.pt.address, abi: bal, functionName: "balanceOf", args: [to] })) > 0n) {
        holder = to;
        d = l.pt;
        break;
      }
    }
    if (holder) {
      const pos = await rt.opportunities.getUserPositions(holder);
      const p = pos.data.find((x) => x.kind === "PRINCIPAL_TOKEN" && x.venue.id === d!.market.toLowerCase());
      const b = await client.readContract({ address: d!.pt.address, abi: bal, functionName: "balanceOf", args: [holder], blockNumber: pos.blockNumber });
      const ok = p && p.shares?.value === b;
      report.add(ok ? "PASS" : "WARN", "positions (PT holder)", `${redact(holder)}: ${pos.data.filter((x) => x.protocol.id === "pendle").length} Pendle positions; PT balance ${ok ? "matches" : "differs from"} independent balanceOf; value ${p?.supplied?.value.amount?.display ?? "?"} ${p?.supplied?.value.asset.symbol ?? ""} ($${p?.supplied?.value.usd?.display.slice(0, 10) ?? "?"}); status ${pos.status}`);
    } else report.warn("positions (PT holder)", "no EOA PT holder found in the scanned window");
  }

  // ---- performance ----
  const t1 = performance.now();
  await rt.opportunities.getOpportunities({ filter: { protocols: ["pendle"] } });
  report.info("performance", `Pendle cold ${coldMs} ms (discovery ${ad.timingsMs.discovery} ms, identity ${ad.timingsMs.identity} ms, state+API ${ad.timingsMs.stateAndApi} ms); warm ${Math.round(performance.now() - t1)} ms`);
  return report;
}

export async function validateCombined(report = new Report("combined-validation")) {
  const rt = runtime();
  const t0 = performance.now();
  const r = await rt.opportunities.getOpportunities();
  const ms = Math.round(performance.now() - t0);
  const st = Object.fromEntries(r.adapters.map((a) => [a.protocol, a.status]));
  report.add(r.status === "UNKNOWN" ? "FAIL" : r.status === "PARTIAL" ? "WARN" : "PASS", "engine (Morpho + Pendle)", `${r.status}; adapters ${JSON.stringify(st)}; ${r.data.length} shown, ${r.excluded?.total ?? 0} hidden ${JSON.stringify(r.excluded?.byReason ?? {})}; ${ms} ms`);
  const ids = r.data.map((o) => o.id);
  report.add(new Set(ids).size === ids.length ? "PASS" : "FAIL", "unique ids", `${ids.length} ids`);
  for (const [sym, key] of [["USDG", `4663:${USDG.toLowerCase()}`], ["NVDA", "4663:0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"]] as const) {
    const a = await rt.opportunities.getAssetOpportunities(key);
    const by = a.data.reduce<Record<string, number>>((m, o) => ((m[`${o.protocol.id}:${o.category}`] = (m[`${o.protocol.id}:${o.category}`] ?? 0) + 1), m), {});
    const protos = new Set(a.data.map((o) => o.protocol.id));
    report.add(protos.has("morpho") && protos.has("pendle") ? "PASS" : "WARN", `asset ${sym}: both protocols`, JSON.stringify(by));
  }
  const s = await rt.opportunities.getOpportunities({ sort: { by: "YIELD", yieldType: "IMPLIED_APY", direction: "DESC" } });
  const ranked = s.data.slice(0, s.data.length - (s.notComparable?.length ?? 0));
  report.add(ranked.every((o) => o.category === "FIXED_YIELD") ? "PASS" : "FAIL", "sorting never mixes metric types", `IMPLIED_APY ranks ${ranked.length} FIXED_YIELD opportunities; ${s.notComparable?.length ?? 0} others listed as not comparable`);
  const m = await rt.opportunities.getOpportunities({ sort: { by: "MATURITY" }, filter: { maturityFromS: BigInt(Math.floor(Date.now() / 1000)) } });
  report.add(m.data.every((o) => o.lifecycle.maturity) ? "PASS" : "FAIL", "maturity filter", `${m.data.length} maturity-based opportunities; first matures ${m.data[0]?.lifecycle.maturity?.value.slice(0, 10) ?? "-"}`);
  report.info("rpc health", JSON.stringify(rt.reader.health()));
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const a = await validatePendleAdapter();
  const ea = a.finish();
  console.log("\n=== combined ===");
  const b = await validateCombined();
  process.exitCode = ea || b.finish();
}
