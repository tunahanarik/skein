/**
 * Developer CLI for the Opportunity Engine. Read-only.
 *
 *   pnpm opportunities                         canonical-asset opportunities (summary + list)
 *   pnpm opportunities --asset NVDA            by symbol (dev convenience → resolved to the canonical address)
 *   pnpm opportunities --asset 0x…             by contract address
 *   pnpm opportunities --address 0x…           opportunities for a wallet's holdings (+ positions)
 *   options: --json  --category LEND|FIXED_YIELD|YIELD|LP|…  --protocol morpho|pendle  --listed-only
 *            --min-liquidity 1000 (USD)  --min-tvl 1000 (USD)  --maturity-after 2026-10-01  --maturity-before 2027-01-01
 *            --sort SUPPLY_APY:DESC | IMPLIED_APY:DESC | BORROW_APY:ASC | TVL | LIQUIDITY | MATURITY  --limit 20
 *   trade (Phase 4): --category TRADE  --protocol uniswap
 *            --asset NVDA --to USDG                 DIRECT and ONE_HOP routes (no amount)
 *            --asset NVDA --to USDG --amount 1      + an INDICATIVE quote per route (explicit amount only)
 *   eligibility (Phase 3): the default view shows only opportunities passing the default policy.
 *            --include-expired  --include-conflicted  --include-unverified   re-admit one exclusion reason
 *            --all | --debug                                                 everything discovered (debug view)
 */
import type { EligibilityReason, Opportunity, YieldMetricType } from "@skein/core/model/opportunity";
import { OPPORTUNITY_CATEGORIES, YIELD_METRIC_TYPES } from "@skein/core/model/opportunity";
import type { OpportunityFilter, SortSpec } from "@skein/engine/opportunities/query";

import type { PortfolioOpportunity } from "@skein/engine/opportunities/userContext";
import { formatFixed18, formatPercent } from "@skein/core/lib/fixed";
import { parseUnits } from "viem";
import { parseAddress, ValidationError } from "@skein/core/lib/validation";
import { createRuntime } from "@skein/runtime/runtime";

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
  protocol?: string;
  minTvl?: string;
  maturityAfter?: string;
  maturityBefore?: string;
  include: EligibilityReason[];
  to?: string;
  amount?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false, all: false, listedOnly: false, limit: 25, include: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (k === "--json") a.json = true;
    else if (k === "--all" || k === "--debug") a.all = true;
    else if (k === "--include-expired") a.include.push("EXPIRED");
    else if (k === "--include-conflicted") a.include.push("DATA_CONFLICT");
    else if (k === "--include-unverified") a.include.push("UNVERIFIED_ASSET", "INSUFFICIENT_VERIFICATION");
    else if (k === "--protocol") a.protocol = next().toLowerCase();
    else if (k === "--min-tvl") a.minTvl = next();
    else if (k === "--maturity-after") a.maturityAfter = next();
    else if (k === "--maturity-before") a.maturityBefore = next();
    else if (k === "--listed-only") a.listedOnly = true;
    else if (k === "--asset") a.asset = next();
    else if (k === "--address") a.address = next();
    else if (k === "--category") a.category = next().toUpperCase();
    else if (k === "--min-liquidity") a.minLiquidity = next();
    else if (k === "--sort") a.sort = next().toUpperCase();
    else if (k === "--limit") a.limit = Number(next()) || 25;
    else if (k === "--to") a.to = next();
    else if (k === "--amount") a.amount = next();
  }
  return a;
}

function parseSort(s: string | undefined): SortSpec | undefined {
  if (!s) return undefined;
  const [what, dir] = s.split(":");
  if (what === "TVL") return { by: "TVL_USD", direction: dir === "ASC" ? "ASC" : "DESC" };
  if (what === "LIQUIDITY") return { by: "LIQUIDITY_USD", direction: dir === "ASC" ? "ASC" : "DESC" };
  if (what === "UTILIZATION" && (dir === "ASC" || dir === "DESC")) return { by: "UTILIZATION", direction: dir };
  if (what === "MATURITY") return { by: "MATURITY", direction: dir === "DESC" ? "DESC" : "ASC" };
  if ((YIELD_METRIC_TYPES as readonly string[]).includes(what ?? "")) {
    if (dir !== "ASC" && dir !== "DESC") throw new ValidationError(`yield sort needs an explicit direction, e.g. ${what}:DESC (a higher BORROW_APY is a higher cost)`);
    return { by: "YIELD", yieldType: what as YieldMetricType, direction: dir };
  }
  throw new ValidationError(`unknown sort "${s}"`);
}

const usd = (d: string | null | undefined) => (d ? "$" + Number(d).toLocaleString("en-US", { maximumFractionDigits: 2 }) : "unknown");
const age = (s: number | null) => (s === null ? "unknown" : s < 120 ? `${s}s ago` : s < 7200 ? `${Math.round(s / 60)}m ago` : `${(s / 3600).toFixed(1)}h ago`);
const pad = (l: string) => `    ${l.padEnd(20)} `;

function parseDateS(s: string, flag: string): bigint {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ValidationError(`${flag} expects YYYY-MM-DD`);
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new ValidationError(`${flag}: invalid date`);
  return BigInt(t / 1000);
}

/** Resolve a CLI symbol or address to ONE canonical registry asset; ambiguity is an error. */
function resolveCanonical(registry: Awaited<ReturnType<ReturnType<typeof createRuntime>["getRegistry"]>>, input: string, json: boolean) {
  if (/^0x/i.test(input)) {
    const addr = parseAddress(input);
    const a = registry.get(4663, addr);
    if (!a || !a.canonical) throw new ValidationError(`${addr} is not a canonical registry asset`);
    return a;
  }
  const hits = registry.canonicalBySymbol(input);
  if (hits.length !== 1) throw new ValidationError(`symbol "${input}" matches ${hits.length} canonical assets; pass the contract address`);
  if (!json) console.log(`(symbol ${input} resolved to canonical ${hits[0]!.address})`);
  return hits[0]!;
}

function printTrade(o: Opportunity): void {
  const m = o.trade?.market;
  if (!m) return;
  if (m.price) {
    const p = o.primaryAsset.key === m.price.base.key ? m.price : m.priceInverse;
    if (p) console.log(pad("Pool price") + `1 ${p.base.symbol} = ${formatFixed18(p.value.value)} ${p.quote.symbol}  [DEX_MARKET_PRICE, onchain slot0; not the portfolio price]`);
  }
  if (m.fee) console.log(pad("Fee tier") + `${(m.fee.value.ppm ?? 0) / 10_000}%  [onchain]`);
  console.log(pad("Pool TVL") + `${usd(m.liquidity.tvl?.value.display)}  [balances × Phase 1 prices]`);
  for (const r of m.liquidity.reserves) console.log(pad("  reserve") + `${r.value.amount?.display} ${r.value.asset.symbol} (${usd(r.value.usd?.display)})`);
  if (m.liquidity.activeLiquidity) console.log(pad("Active liquidity L") + `${m.liquidity.activeLiquidity.value}  (in-range, not USD)`);
  console.log(pad("Route") + `${o.trade!.route.kind}: ${o.primaryAsset.symbol} → ${o.outputAssets[0]?.symbol}  · state ${m.state} · origin ${m.originVerified ? "factory-verified" : "NOT verified"}`);
  console.log(pad("24h volume") + "not reported (needs Swap-log indexing; not verified in Phase 4)");
}

function printOpportunity(o: Opportunity): void {
  console.log(`\n  ${o.protocol.name.toUpperCase()}  ${o.category}  ${o.title}`);
  console.log(pad("id") + o.id);
  const lc = o.lifecycle;
  if (lc.maturity) console.log(pad("Maturity") + `${lc.maturity.value.slice(0, 10)}  (${lc.state}${lc.secondsToMaturity !== null && lc.secondsToMaturity > 0 ? `, ${(lc.secondsToMaturity / 86_400).toFixed(1)} days left` : ""})  [${lc.maturity.source.type === "ONCHAIN" ? "onchain" : lc.maturity.source.provider}]`);
  else if (lc.state !== "ACTIVE" || lc.blockers.length) console.log(pad("State") + `${lc.state}${lc.blockers.length ? ` · blocked: ${lc.blockers.join(", ")}` : ""}`);
  if (o.entry.kind !== "DIRECT") console.log(pad("Entry") + `${o.entry.kind}: ${o.entry.steps.map((s) => `${s.action} ${s.from?.symbol ?? "?"}→${s.to?.symbol ?? "?"}${s.verified ? "" : " (unverified)"}`).join(" → ") || "unknown"}${o.entry.singleTransactionAvailable.known && o.entry.singleTransactionAvailable.value ? " · one router call available" : ""}`);
  if (o.details.kind === "PENDLE_MARKET") {
    const d = o.details;
    if (d.ptDiscount && o.category === "FIXED_YIELD") console.log(pad("PT discount") + `${formatPercent(d.ptDiscount.value, 3)} below maturity value (spot, before fees/slippage) [onchain]`);
    if (d.accountingUnit.assetType !== "TOKEN") console.log(pad("Accounting unit") + d.accountingUnit.description);
  }
  if (o.eligibility && !o.eligibility.eligibleForDefaultDisplay) console.log(pad("NOT in default view") + o.eligibility.excludedBy.join(", "));
  if (o.eligibility?.advisories.length) console.log(pad("Advisories") + o.eligibility.advisories.join(", "));
  for (const y of o.yields) console.log(pad(y.type + (y.side === "PAY" ? " (cost)" : "")) + `${formatPercent(y.value)}  [${y.label}; ${y.origin === "SUPPLIED" ? "protocol-supplied" : "computed"}, ${y.source.provider}, ${age(y.freshness.ageSeconds)}]`);
  if (o.category === "TRADE") printTrade(o);
  if (o.liquidation) {
    console.log(pad("LLTV") + `${formatPercent(o.liquidation.lltv.value, 1)}  [onchain]`);
    if (o.liquidation.liquidationIncentiveFactor) console.log(pad("Liq. incentive") + `${formatFixed18(o.liquidation.liquidationIncentiveFactor.value)}×  [computed from LLTV]`);
  }
  if (o.availableLiquidity && o.category !== "TRADE") console.log(pad(o.liquidityKind === "POOL_LIQUIDITY" ? "Pool liquidity" : "Available liquidity") + `${o.availableLiquidity.value.amount?.display ?? "?"} ${o.availableLiquidity.value.asset.symbol} (${usd(o.availableLiquidity.value.usd?.display)})`);
  if (o.utilization) console.log(pad("Utilization") + formatPercent(o.utilization.value));
  if (o.tvl && o.category !== "TRADE") console.log(pad(o.category === "COLLATERAL" ? "Collateral posted" : "TVL") + `${o.tvl.value.amount?.display ?? "?"} ${o.tvl.value.asset.symbol} (${usd(o.tvl.value.usd?.display)}) [${o.tvl.source.provider}]`);
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
      console.log(pad("Protocol max borrow") + `${c.protocolMaximumBorrow.amount?.display} ${c.protocolMaximumBorrow.asset.symbol} (${usd(c.protocolMaximumBorrow.usd?.display)}) — AT the liquidation threshold, not a safe amount`);
      if (c.protocolMaximumBorrowLiquidityCapped) console.log(pad("  capped by liquidity") + `${c.protocolMaximumBorrowLiquidityCapped.amount?.display} ${c.protocolMaximumBorrowLiquidityCapped.asset.symbol}`);
    } else console.log(pad("Protocol max borrow") + `unavailable (${c.unavailableReason})`);
  } else if (c.kind === "SUPPLY") {
    console.log(pad("You could supply") + `${c.suppliable.amount?.display} ${c.suppliable.asset.symbol} (${usd(c.suppliable.usd?.display)})`);
  } else if (c.kind === "TRADE") {
    console.log(pad("You hold") + `${c.held.amount?.display} ${c.held.asset.symbol} (${usd(c.held.usd?.display)}) → tradable to ${c.to.symbol} (${c.routeKind}); ${c.note}`);
  } else if (c.kind === "ENTER_POSITION") {
    console.log(pad("You could enter with") + `${c.enterWith.amount?.display} ${c.enterWith.asset.symbol} (${usd(c.enterWith.usd?.display)}) — ${c.caveat}`);
  }
}

const args = parseArgs(process.argv.slice(2));
try {
  const rt = createRuntime();
  const registry = await rt.getRegistry();
  const filter: OpportunityFilter = {
    ...(args.all || args.include.includes("UNVERIFIED_ASSET") ? {} : { canonicalOnly: true }),
    ...(args.protocol ? { protocols: [args.protocol] } : {}),
    ...(args.minTvl ? { minTvlUsdE18: parseUnits(args.minTvl, 18) } : {}),
    ...(args.maturityAfter ? { maturityFromS: parseDateS(args.maturityAfter, "--maturity-after") } : {}),
    ...(args.maturityBefore ? { maturityToS: parseDateS(args.maturityBefore, "--maturity-before") } : {}),
    ...(args.listedOnly ? { protocolListedOnly: true } : {}),
    ...(args.category ? { categories: [args.category as (typeof OPPORTUNITY_CATEGORIES)[number]] } : {}),
    ...(args.minLiquidity ? { minLiquidityUsdE18: parseUnits(args.minLiquidity, 18) } : {}),
  };
  if (args.category && !(OPPORTUNITY_CATEGORIES as readonly string[]).includes(args.category)) throw new ValidationError(`unknown category ${args.category}`);
  // Default: deepest available liquidity first (an objective, category-agnostic order).
  const sort: SortSpec = parseSort(args.sort) ?? { by: "LIQUIDITY_USD", direction: "DESC" };
  const eligibility = { eligibility: args.all ? ("ALL" as const) : ("ELIGIBLE_ONLY" as const), includeReasons: args.include };

  if (args.address) {
    const portfolio = await rt.getPortfolio(args.address);
    const res = await rt.opportunities.getPortfolioOpportunities(portfolio, { filter, sort, ...eligibility });
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
        if (p.kind === "PRINCIPAL_TOKEN" || p.kind === "YIELD_TOKEN" || p.kind === "LIQUIDITY_POOL") {
          console.log(`  ${p.protocol.name} ${p.kind} ${p.venue.id.slice(0, 12)}…  balance ${p.shares?.value ?? "-"} (raw)  worth ${p.supplied?.value.amount?.display ?? "?"} ${p.supplied?.value.asset.symbol ?? ""} (${usd(p.supplied?.value.usd?.display)})  maturity ${p.maturity?.at.slice(0, 10) ?? "-"}${p.maturity?.expired ? " (matured)" : ""}`);
          continue;
        }
        console.log(`  ${p.protocol.name} ${p.kind} ${p.venue.id.slice(0, 12)}…  supplied ${p.supplied?.value.amount?.display ?? "-"}  borrowed ${p.borrowed?.value.amount?.display ?? "-"}  collateral ${p.collateral?.value.amount?.display ?? "-"}  HF ${p.healthFactor ? formatFixed18(p.healthFactor.value).slice(0, 6) : "-"}  liquidatable ${p.liquidatable ?? "-"}`);
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
    if (args.to) {
      if (!args.asset) throw new ValidationError("--to needs --asset");
      const from = resolveCanonical(registry, args.asset, args.json);
      const to = resolveCanonical(registry, args.to, args.json);
      const routes = await rt.opportunities.getTradeRoutes(from.key, to.key);
      let amountRaw: bigint | null = null;
      if (args.amount !== undefined) {
        if (!/^\d+(\.\d+)?$/.test(args.amount)) throw new ValidationError("--amount must be a positive decimal number");
        amountRaw = parseUnits(args.amount, from.decimals);
        if (amountRaw <= 0n) throw new ValidationError("--amount must be positive");
      }
      const all = [...routes.data.direct, ...routes.data.oneHop];
      const quotes = amountRaw === null ? [] : await Promise.all(all.map((r) => rt.opportunities.getTradeQuote(r, amountRaw!)));
      if (args.json) {
        console.log(JSON.stringify({ routes: routes.data, quotes }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
      } else {
        console.log(`ROUTES ${from.symbol} → ${to.symbol}  block ${routes.blockNumber}  status ${routes.status}  (${routes.data.direct.length} direct, ${routes.data.oneHop.length} one-hop; order: ${routes.data.ordering}; ${routes.data.edges} verified edges, graph ${routes.data.graphMs} ms)`);
        all.forEach((r, i) => {
          const tvl = r.properties.bottleneckTvlUsd ? usd(r.properties.bottleneckTvlUsd.display) : "unknown";
          console.log(`\n  ${r.kind}  ${[r.input, ...r.intermediates, r.output].map((a) => a.symbol).join(" → ")}  via ${r.hops.map((h) => h.marketId.split(":").pop()!.slice(0, 10) + "… (" + (h.fee?.ppm ?? "?") + " ppm)").join(", ")}`);
          console.log(pad("bottleneck TVL") + `${tvl} · combined fee ${r.properties.combinedFeePpm ?? "?"} ppm · all verified ${r.properties.allMarketsVerified} · all canonical ${r.properties.allAssetsCanonical}`);
          const q = quotes[i];
          if (q?.ok) {
            const qq = q.quote;
            console.log(pad("INDICATIVE QUOTE") + `${qq.input.display} ${qq.input.asset.symbol} → ${qq.expectedOutput.display} ${qq.expectedOutput.asset.symbol}  (not guaranteed; no minimum output)`);
            console.log(pad("  effective price") + `${formatFixed18(qq.effectivePrice)} ${qq.expectedOutput.asset.symbol}/${qq.input.asset.symbol} · price impact ${qq.priceImpact === null ? "n/a" : formatPercent(qq.priceImpact, 4)} (fees excluded) · block ${qq.blockNumber}`);
            for (const f of qq.fees ?? []) console.log(pad(`  fee hop ${f.hop + 1}`) + `${f.amount.display} ${f.asset.symbol}`);
          } else if (q) console.log(pad("quote") + `unavailable: ${q.reason}`);
        });
        if (!all.length) console.log("  no verified route (direct or one hop via USDG/WETH)");
      }
      process.exit(0);
    }
    const res = assetKey ? await rt.opportunities.getAssetOpportunities(assetKey, { filter, sort, ...eligibility }) : await rt.opportunities.getOpportunities({ filter, sort, ...eligibility });
    if (args.json) console.log(JSON.stringify(res, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    else {
      const byCat = res.data.reduce<Record<string, number>>((m, o) => ((m[o.category] = (m[o.category] ?? 0) + 1), m), {});
      console.log(`OPPORTUNITIES  block ${res.blockNumber}  status ${res.status}  ${res.data.length} shown ${JSON.stringify(byCat)}  (${args.all ? "debug: everything discovered" : "default eligibility view"})`);
      for (const a of res.adapters) console.log(`  adapter ${a.protocol}: ${a.status}, ${a.itemCount} items, ${a.timingsMs.total} ms, ${a.issues.length} issues`);
      if (res.excluded?.total) console.log(`  ${res.excluded.total} discovered opportunities hidden by the default eligibility policy ${JSON.stringify(res.excluded.byReason)} (--include-expired / --include-conflicted / --debug)`);
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

