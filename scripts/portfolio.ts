/**
 * Developer CLI for the Portfolio Engine. Read-only; needs only a public wallet address.
 *
 *   pnpm portfolio --address 0x…                 human-readable
 *   pnpm portfolio --address 0x… --json          machine-readable (bigints as strings)
 *   pnpm portfolio --address 0x… --include-zero  also list zero balances
 *   pnpm portfolio --address 0x… --token 0x…     inspect an extra (unknown) token
 */
import { portfolioToJson } from "../src/portfolio/engine.js";
import type { Portfolio, PortfolioAsset } from "../src/portfolio/types.js";
import { createRuntime } from "../src/runtime.js";
import { ValidationError } from "../src/lib/validation.js";

function parseArgs(argv: string[]) {
  const out: { address?: string; json: boolean; includeZero: boolean; tokens: string[] } = { json: false, includeZero: false, tokens: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--json") out.json = true;
    else if (a === "--include-zero") out.includeZero = true;
    else if (a === "--address") out.address = argv[++i] ?? "";
    else if (a === "--token") out.tokens.push(argv[++i] ?? "");
    else if (!a.startsWith("--") && !out.address) out.address = a; // positional shorthand
  }
  return out;
}

const usd = (s: string | null) => (s === null ? "—" : "$" + Number(s).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const num = (s: string | null, max = 8) => (s === null ? "—" : Number(s).toLocaleString("en-US", { maximumFractionDigits: max }));
const pad = (label: string) => `  ${label.padEnd(18)} `;

function printAsset(r: PortfolioAsset): void {
  const q = r.price;
  const tag = r.asset.canonical ? r.asset.type : `${r.asset.type} (NOT CANONICAL)`;
  console.log(`\n${r.asset.symbol}  ·  ${tag}  ·  ${r.asset.address ?? "native"}`);
  if (r.balanceStatus === "FAILED") {
    console.log(pad("Balance") + "READ FAILED");
  } else if (r.stock) {
    console.log(pad("Raw balance") + `${r.rawBalance} (token base units, 18 dp)`);
    console.log(pad("Tokens held") + num(r.displayBalance, 12));
    console.log(pad("Multiplier") + `${r.stock.uiMultiplier} (${r.stock.multiplierSource})`);
    console.log(pad("Display shares") + `${num(r.stock.displayShareBalance, 12)} share-equivalents`);
  } else {
    console.log(pad("Balance") + `${num(r.displayBalance, 12)} (raw ${r.rawBalance})`);
  }
  if (q?.status === "PRICED") {
    console.log(pad("Price") + `${usd(q.priceUsdDisplay)} per token`);
    console.log(pad("Value") + usd(r.valueUsd));
    console.log(pad("Price source") + `${q.method} · ${q.source?.provider}${q.source?.contract ? " " + q.source.contract : ""}`);
    console.log(pad("Freshness") + `${q.freshnessStatus}, age ${q.ageSeconds}s, confidence ${q.confidence}, ${q.verificationStatus}`);
    if (q.robinhoodQuote) {
      const rq = q.robinhoodQuote;
      console.log(pad("RH quote") + `bid ${rq.bid} / ask ${rq.ask} (underlying), spread ${rq.spreadBps?.toFixed(1) ?? "—"} bps, ${rq.freshness}`);
    }
    if (q.crossCheck?.performed) console.log(pad("Cross-check") + `${q.crossCheck.percentageDifference?.toFixed(3)}% vs Robinhood-implied${q.crossCheck.conflict ? "  ⚠ CONFLICT" : ""}`);
    if (q.pegDeviationBps !== null) console.log(pad("Peg deviation") + `${q.pegDeviationBps.toFixed(1)} bps`);
  } else if (r.balanceStatus === "OK") {
    console.log(pad("Price") + `UNPRICED — ${q?.unpricedReason ?? "not priced"}`);
  }
  for (const w of r.warnings.filter((x) => x.code !== "UNPRICED_ASSET")) console.log(pad("⚠ " + w.code) + w.message);
}

function printPortfolio(p: Portfolio): void {
  console.log("PORTFOLIO");
  console.log(`\nWallet   ${p.walletAddress}`);
  console.log(`Network  Robinhood Chain (chainId ${p.chainId}) · block ${p.blockNumber} · ${p.blockTimestamp}`);
  console.log(`Registry ${p.registry.mode} · ${p.registry.stockTokenCount} Stock Tokens · data ${p.registry.freshness.status} (${p.registry.freshness.ageSeconds}s) · onchain-verified ${p.registry.onchainVerified ?? "—"}`);
  for (const r of p.assets) printAsset(r);
  const c = p.valuationCoverage;
  console.log("\nSUMMARY");
  console.log(pad("Priced value") + usd(p.totals.pricedValueUsd) + (c.coverageStatus === "COMPLETE" ? "  (complete: this is the total)" : "  (NOT a total: coverage " + c.coverageStatus + ")"));
  console.log(pad("Priced assets") + c.pricedAssets);
  console.log(pad("Unpriced assets") + c.unpricedAssets);
  console.log(pad("Failed balances") + c.failedBalances);
  const counts = p.warnings.concat(p.assets.flatMap((a) => a.warnings)).reduce<Record<string, number>>((m, w) => ((m[w.code] = (m[w.code] ?? 0) + 1), m), {});
  console.log(pad("Warnings") + (Object.keys(counts).length ? Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(", ") : "none"));
  for (const w of p.warnings) console.log(pad("  " + w.code) + w.message);
  const t = p.timingsMs;
  console.log(pad("Duration") + `${t.total} ms (registry ${t.registry}, balances ${t.balances}, prices ${t.prices}, normalize ${t.normalization})`);
  console.log(pad("RPC") + `${p.rpc.status} · ${p.rpc.requests} requests · avg ${p.rpc.avgLatencyMs} ms · p95 ${p.rpc.p95LatencyMs} ms · ${p.rpc.endpoint}`);
}

const args = parseArgs(process.argv.slice(2));
if (!args.address) {
  console.error("usage: pnpm portfolio --address 0x… [--json] [--include-zero] [--token 0x…]");
  process.exit(2);
}
try {
  const rt = createRuntime();
  const p = await rt.getPortfolio(args.address, { includeZeroBalances: args.includeZero, extraTokens: args.tokens });
  if (args.json) console.log(portfolioToJson(p));
  else printPortfolio(p);
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(`invalid input: ${e.message}`);
    process.exit(2);
  }
  throw e;
}
