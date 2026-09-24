/**
 * Shared CLI helpers for the Phase 5 product read API: symbol → canonical asset resolution and a
 * human-readable printer for AssetIntelligence. Output only; nothing here is persisted.
 */
import { ValidationError, parseAddress } from "../../src/lib/validation.js";
import type { AssetRegistry } from "../../src/registry/registry.js";
import type { AssetIntelligence, ProductCard } from "../../src/product/types.js";

export const toJson = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);

/** External strings are printed without control characters (defence in depth; they are sanitized upstream). */
export const clean = (s: string | null | undefined) => (s ?? "").replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "");

export function argOf(argv: string[], k: string): string | undefined {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Symbol or address → canonical registry key. Ambiguous symbols must be passed as addresses. */
export function resolveCanonical(registry: AssetRegistry, input: string | undefined, flag: string): string {
  if (!input) throw new ValidationError(`${flag} is required`);
  if (/^0x/i.test(input)) {
    const a = registry.get(4663, parseAddress(input));
    if (!a) throw new ValidationError(`${input} is not in the asset registry`);
    return a.key;
  }
  const hits = registry.canonicalBySymbol(input);
  if (hits.length !== 1) throw new ValidationError(`symbol "${input}" matches ${hits.length} canonical assets; pass the contract address`);
  return hits[0]!.key;
}

function cardLine(c: ProductCard): string {
  const pos = c.ranking ? `${c.ranking.position}.` : "-";
  const head = c.headline ? `${c.headline.display} ${c.headline.type}` : "";
  const liq = c.liquidity?.usd ? `liq $${Number(c.liquidity.usd.display).toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "liq —";
  const q = c.trade?.quote;
  const trade = c.trade ? `${c.trade.route.path.map((a) => clean(a.symbol)).join(">")}  fee ${c.trade.route.combinedFeePpm ?? "?"}ppm${q ? `  out ${q.expectedOutput.display} ${clean(q.expectedOutput.asset.symbol)}  impact ${q.priceImpactClass}` : ""}` : "";
  const why = [...c.usability.reasons, ...c.usability.notes.map((n) => `note:${n}`)].join(",");
  return `    ${pos.padEnd(4)}${c.usability.status.padEnd(18)}${clean(c.actionLabel).padEnd(38)}${head.padEnd(28)}${liq.padEnd(18)}${trade}${why ? `  [${why}]` : ""}`;
}

export function printIntelligence(v: AssetIntelligence): void {
  const a = v.asset;
  console.log(`\n${a ? `${clean(a.symbol)} · ${a.registryType ?? "NON-CANONICAL"} · ${a.address}` : `unknown asset ${clean(v.query.asset)}`}  (block ${v.blockNumber}, ${v.mode})`);
  if (v.emptyStates.length) console.log(`  empty states: ${v.emptyStates.join(", ")}`);
  if (v.price) console.log(`  price: ${v.price.usd ? `$${v.price.usd} (${v.price.method}, ${v.price.freshness})` : `unpriced — ${v.price.unpricedReason}`}`);
  if (v.balance) {
    console.log(`  balance: ${v.balance.displayBalance} tokens${v.balance.valueUsd ? ` ≈ $${v.balance.valueUsd.display}` : ""}`);
    if (v.balance.stock) console.log(`           share-equivalent ${v.balance.stock.displayShareBalance} (uiMultiplier ${v.balance.stock.uiMultiplier}, display only)`);
  }
  const cap = v.summary.capabilities.detail;
  console.log(`  can: TRADE ${cap.TRADE} · EARN ${cap.EARN} · BORROW ${cap.BORROW} · LIQUIDITY ${cap.LIQUIDITY}`);
  const n = v.summary.counts;
  console.log(`  counts: discovered ${n.discovered} · verified ${n.verified} · actionable ${n.actionable} · limited ${n.limited} · informational ${n.informational} · hidden ${n.hidden} · unavailable ${n.unavailable}`);
  console.log(`  protocols: ${v.summary.protocols.join(", ") || "—"}  (discovered: ${v.summary.allDiscoveredProtocols.join(", ") || "—"})`);
  console.log(`  data quality: ${v.dataQuality.status}${v.dataQuality.reasons.length ? ` — ${v.dataQuality.reasons.map((r) => r.code).join(", ")}` : ""}`);
  console.log(`  freshness: oldest ${v.freshness.oldestCriticalDataAt ?? "—"} · newest ${v.freshness.newestDataAt ?? "—"} · stale ${v.freshness.staleSources.length}`);
  for (const c of v.categories) {
    console.log(`\n  ${c.category}`);
    for (const s of c.subcategories) {
      console.log(`   ${s.subcategory}  (ordered by ${s.comparator})`);
      let lastTarget = "";
      let lastSymbol = "";
      const more = (t: string) => {
        const m = s.moreRoutes?.find((x) => x.target === t);
        if (m) console.log(`    … ${m.total - m.shown} more route(s) to ${lastSymbol} (use --debug)`);
      };
      for (const card of s.cards) {
        const t = card.ranking?.context?.target;
        if (t && t !== lastTarget) {
          if (lastTarget) more(lastTarget);
          lastSymbol = clean(card.trade?.route.path.at(-1)?.symbol);
          console.log(`   → ${lastSymbol}`);
          lastTarget = t;
        }
        console.log(cardLine(card));
        if (card.borrowCapacity?.maxBorrow) console.log(`         theoretical limit ${card.borrowCapacity.maxBorrow.amount.display} ${clean(card.borrowCapacity.maxBorrow.asset.symbol)} (not a recommendation; liquidation at this limit)`);
        if (card.fixedYield) console.log(`         maturity ${card.fixedYield.maturity} (${card.fixedYield.daysToMaturity ?? "?"} d) · unit ${card.fixedYield.accountingUnit.assetType}`);
      }
      if (lastTarget) more(lastTarget);
    }
  }
  if (v.otherTradeDestinations.direct + v.otherTradeDestinations.oneHop) console.log(`\n  other trade destinations: ${v.otherTradeDestinations.direct} direct, ${v.otherTradeDestinations.oneHop} one-hop (use --to)`);
  if (v.excluded?.length) {
    console.log(`\n  EXCLUDED (debug): ${v.excluded.length}`);
    for (const c of v.excluded) console.log(cardLine(c));
  }
}
