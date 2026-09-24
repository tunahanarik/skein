/**
 * Developer CLI for the Opportunity Engine. Read-only.
 *
 *   pnpm opportunities                         canonical-asset opportunities (summary + list)
 *   pnpm opportunities --asset NVDA            by symbol (dev convenience → resolved to the canonical address)
 *   pnpm opportunities --asset 0x…             by contract address
 *   pnpm opportunities --address 0x…           opportunities for a wallet's holdings (+ positions)
 *   options: --json  --all (include non-canonical)  --category LEND  --listed-only
 *            --min-liquidity 1000 (USD)  --sort SUPPLY_APY:DESC | BORROW_APY:ASC | TVL | LIQUIDITY  --limit 20
 */
import type { Opportunity, YieldMetricType } from "../src/model/opportunity.js";
import { OPPORTUNITY_CATEGORIES, YIELD_METRIC_TYPES } from "../src/model/opportunity.js";
import type { OpportunityFilter, SortSpec } from "../src/opportunities/query.js";

import type { PortfolioOpportunity } from "../src/opportunities/userContext.js";
import { formatFixed18, formatPercent } from "../src/lib/fixed.js";
import { parseUnits } from "viem";
import { parseAddress, ValidationError } from "../src/lib/validation.js";
import { createRuntime } from "../src/runtime.js";

interface Args {
  asset?: string;
  address?: string;
  json: boolean;
  all: boolean;
  category?: string;
  listedOnly: boolean;
  minLiquidity?: string;
  sort?: string;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, all: false, listedOnly: false, limit: 25 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (k === "--json") a.json = true;
    else if (k === "--all") a.all = true;
    else if (k === "--listed-only") a.listedOnly = true;
    else if (k === "--asset") a.asset = next();
    else if (k === "--address") a.address = next();
    else if (k === "--category") a.category = next().toUpperCase();
    else if (k === "--min-liquidity") a.minLiquidity = next();
    else if (k === "--sort") a.sort = next().toUpperCase();
    else if (k === "--limit") a.limit = Number(next()) || 25;
  }
  return a;
}

function parseSort(s: string | undefined): SortSpec | undefined {
  if (!s) return undefined;
  const [what, dir] = s.split(":");
  if (what === "TVL") return { by: "TVL_USD", direction: dir === "ASC" ? "ASC" : "DESC" };
  if (what === "LIQUIDITY") return { by: "LIQUIDITY_USD", direction: dir === "ASC" ? "ASC" : "DESC" };
  if (what === "UTILIZATION" && (dir === "ASC" || dir === "DESC")) return { by: "UTILIZATION", direction: dir };
  if ((YIELD_METRIC_TYPES as readonly string[]).includes(what ?? "")) {
    if (dir !== "ASC" && dir !== "DESC") throw new ValidationError(`yield sort needs an explicit direction, e.g. ${what}:DESC (a higher BORROW_APY is a higher cost)`);
    return { by: "YIELD", yieldType: what as YieldMetricType, direction: dir };
  }
  throw new ValidationError(`unknown sort "${s}"`);
}

const usd = (d: string | null | undefined) => (d ? "$" + Number(d).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "unknown");
const age = (s: number | null) => (s === null ? "unknown" : s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`);
const pad = (l: string) => `    ${l.padEnd(20)} `;

function printOpportunity(o: Opportunity): void {
  console.log(`\n  ${o.protocol.name.toUpperCase()}  ${o.category}  ${o.title}`);
  console.log(pad("id") + o.id);
  for (const y of o.yields) console.log(pad(y.type + (y.side === "PAY" ? " (cost)" : "")) + `${formatPercent(y.value)}  [${y.label}; ${y.origin === "SUPPLIED" ? "protocol-supplied" : "computed"}, ${y.source.provider}, ${age(y.freshness.ageSeconds)}]`);
  if (o.liquidation) {
    console.log(pad("LLTV") + `${formatPercent(o.liquidation.lltv.value, 1)}  [onchain]`);
    if (o.liquidation.liquidationIncentiveFactor) console.log(pad("Liq. incentive") + `${formatFixed18(o.liquidation.liquidationIncentiveFactor.value)}×  [computed from LLTV]`);
  }
  if (o.availableLiquidity) console.log(pad("Available liquidity") + `${o.availableLiquidity.value.amount.display} ${o.availableLiquidity.value.asset.symbol} (${usd(o.availableLiquidity.value.usd?.display)})`);
  if (o.utilization) console.log(pad("Utilization") + formatPercent(o.utilization.value));
  if (o.tvl) console.log(pad(o.category === "COLLATERAL" ? "Collateral posted" : "TVL") + `${o.tvl.value.amount.display} ${o.tvl.value.asset.symbol} (${usd(o.tvl.value.usd?.display)}) [${o.tvl.source.provider}]`);
  if (o.risk.oracle) console.log(pad("Oracle") + `${o.risk.oracle.address} ${o.risk.oracle.reportedType ?? ""} · check: ${o.risk.oracle.multiplierCheck}`);
  console.log(pad("Listed by protocol") + (o.risk.protocolListed.known ? String(o.risk.protocolListed.value) : "unknown"));
  console.log(pad("Verification") + `${o.verificationStatus} · freshness ${o.freshness.status} (${age(o.freshness.ageSeconds)})`);
  const shown = o.warnings.filter((w) => w.code !== "PROTOCOL_WARNING" || w.severity !== "INFO");
  for (const w of shown.slice(0, 6)) console.log(pad("⚠ " + w.code) + w.message);
  if (shown.length > 6) console.log(pad("") + `… ${shown.length - 6} more warnings`);
}

function printPortfolioOpportunity(p: PortfolioOpportunity): void {
  printOpportunity(p.opportunity);
  const c = p.context;
  if (c.kind === "COLLATERAL") {
    if (c.protocolMaximumBorrow) {
      console.log(pad("Protocol max borrow") + `${c.protocolMaximumBorrow.amount.display} ${c.protocolMaximumBorrow.asset.symbol} (${usd(c.protocolMaximumBorrow.usd?.display)}) — AT the liquidation threshold, not a safe amount`);
      if (c.protocolMaximumBorrowLiquidityCapped) console.log(pad("  capped by liquidity") + `${c.protocolMaximumBorrowLiquidityCapped.amount.display} ${c.protocolMaximumBorrowLiquidityCapped.asset.symbol}`);
    } else console.log(pad("Protocol max borrow") + `unavailable (${c.unavailableReason})`);
  } else if (c.kind === "SUPPLY") {
    console.log(pad("You could supply") + `${c.suppliable.amount.display} ${c.suppliable.asset.symbol} (${usd(c.suppliable.usd?.display)})`);
  }
}

const args = parseArgs(process.argv.slice(2));
try {
  const rt = createRuntime();
  const registry = await rt.getRegistry();
  const filter: OpportunityFilter = {
    ...(args.all ? {} : { canonicalOnly: true }),
    ...(args.listedOnly ? { protocolListedOnly: true } : {}),
    ...(args.category ? { categories: [args.category as (typeof OPPORTUNITY_CATEGORIES)[number]] } : {}),
    ...(args.minLiquidity ? { minLiquidityUsdE18: parseUnits(args.minLiquidity, 18) } : {}),
  };
  if (args.category && !(OPPORTUNITY_CATEGORIES as readonly string[]).includes(args.category)) throw new ValidationError(`unknown category ${args.category}`);
  // Default: deepest available liquidity first (an objective, category-agnostic order).
  const sort: SortSpec = parseSort(args.sort) ?? { by: "LIQUIDITY_USD", direction: "DESC" };

  if (args.address) {
    const portfolio = await rt.getPortfolio(args.address);
    const res = await rt.opportunities.getPortfolioOpportunities(portfolio, { filter, sort });
    const positions = await rt.opportunities.getUserPositions(args.address);
    if (args.json) {
      console.log(JSON.stringify({ portfolio: { walletAddress: portfolio.walletAddress, pricedValueUsd: portfolio.totals.pricedValueUsd, coverage: portfolio.valuationCoverage }, opportunities: res, positions }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    } else {
      console.log(`OPPORTUNITIES FOR WALLET ${portfolio.walletAddress}  (block ${res.blockNumber}, status ${res.status})`);
      for (const g of res.data.filter((x) => x.items.length > 0)) {
        const row = portfolio.assets.find((a) => a.asset.key === g.assetKey)!;
        console.log(`\n${row.asset.symbol}   Owned: ${row.displayBalance} ${row.asset.symbol}${row.stock ? ` (${row.stock.displayShareBalance} share-equiv.)` : ""}   ${usd(row.valueUsd)}   Opportunities: ${g.items.length}`);
        for (const p of g.items.slice(0, args.limit)) printPortfolioOpportunity(p);
      }
      const none = res.data.filter((x) => x.items.length === 0).length;
      console.log(`\n${none} held assets have no verified opportunity under the current filter.`);
      console.log(`\nPOSITIONS (${positions.data.length}, status ${positions.status})`);
      for (const p of positions.data) {
        console.log(`  ${p.protocol.name} ${p.kind} ${p.venue.id.slice(0, 12)}…  supplied ${p.supplied?.value.amount.display ?? "-"}  borrowed ${p.borrowed?.value.amount.display ?? "-"}  collateral ${p.collateral?.value.amount.display ?? "-"}  HF ${p.healthFactor ? formatFixed18(p.healthFactor.value).slice(0, 6) : "-"}  liquidatable ${p.liquidatable ?? "-"}`);
      }
    }
  } else {
    let assetKey: string | undefined;
    if (args.asset) {
      if (/^0x/i.test(args.asset)) assetKey = `4663:${parseAddress(args.asset).toLowerCase()}`;
      else {
        const hits = registry.canonicalBySymbol(args.asset);
        if (hits.length !== 1) throw new ValidationError(`symbol "${args.asset}" matches ${hits.length} canonical assets; pass the contract address`);
        assetKey = hits[0]!.key;
        if (!args.json) console.log(`(symbol ${args.asset} resolved to canonical ${hits[0]!.address})`);
      }
    }
    const res = assetKey ? await rt.opportunities.getAssetOpportunities(assetKey, { filter, sort }) : await rt.opportunities.getOpportunities({ filter, sort });
    if (args.json) console.log(JSON.stringify(res, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    else {
      const byCat = res.data.reduce<Record<string, number>>((m, o) => ((m[o.category] = (m[o.category] ?? 0) + 1), m), {});
      console.log(`OPPORTUNITIES  block ${res.blockNumber}  status ${res.status}  ${res.data.length} shown ${JSON.stringify(byCat)}  (${args.all ? "all assets" : "canonical assets only; --all to include others"})`);
      for (const a of res.adapters) console.log(`  adapter ${a.protocol}: ${a.status}, ${a.itemCount} items, ${a.timingsMs.total} ms, ${a.issues.length} issues`);
      if (res.notComparable?.length) console.log(`  ${res.notComparable.length} opportunities lack the sort metric and are listed last`);
      for (const o of res.data.slice(0, args.limit)) printOpportunity(o);
      if (res.data.length > args.limit) console.log(`\n… ${res.data.length - args.limit} more (--limit)`);
    }
  }
} catch (e) {
  if (e instanceof ValidationError) {
    console.error(`invalid input: ${e.message}`);
    process.exit(2);
  }
  throw e;
}

