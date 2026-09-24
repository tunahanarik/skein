/**
 * Developer CLI: portfolio intelligence for a public wallet address (read-only).
 *
 *   pnpm portfolio:view --address 0x…         per held asset: what can be done with it
 *   pnpm portfolio:view --address 0x… --json  machine-readable
 *
 * The address is used only for onchain balance reads; it is not written to disk, logged, or sent
 * to any protocol API. Balances are never quoted automatically.
 */
import { ValidationError } from "../src/lib/validation.js";
import { createRuntime } from "../src/runtime.js";
import { argOf, clean, printIntelligence, toJson } from "./lib/intelligence.js";

const argv = process.argv.slice(2);
try {
  const address = argOf(argv, "--address") ?? argv.find((a) => /^0x/i.test(a));
  if (!address) throw new ValidationError("--address is required");
  const rt = createRuntime();
  const t0 = performance.now();
  const p = await rt.intelligence.getPortfolioIntelligence(address, { mode: argv.includes("--debug") ? "DEBUG" : "PRODUCT" });
  if (argv.includes("--json")) console.log(toJson(p));
  else {
    console.log(`PORTFOLIO INTELLIGENCE  block ${p.blockNumber}`);
    console.log(`  value: total ${p.portfolioValueUsd ?? "incomplete"} · priced ${p.pricedValueUsd} · supported ${p.supportedAssetValueUsd} · unsupported ${p.unsupportedAssetValueUsd} · unpriced assets ${p.unpricedAssetCount}`);
    const n = p.opportunityCounts;
    console.log(`  opportunities: discovered ${n.discovered} · actionable ${n.actionable} · limited ${n.limited} · hidden ${n.hidden + n.unavailable}`);
    console.log(`  data quality: ${p.dataQuality.status}${p.dataQuality.reasons.length ? ` — ${p.dataQuality.reasons.map((r) => r.code).join(", ")}` : ""}`);
    for (const u of p.unsupportedAssets) console.log(`  unsupported: ${clean(u.asset.symbol)} — ${u.reason}${u.valueUsd ? ` ($${u.valueUsd})` : ""}`);
    for (const a of p.assets) printIntelligence(a);
    console.log(`\n(${Math.round(performance.now() - t0)} ms; read-only)`);
  }
} catch (e) {
  console.error(e instanceof ValidationError ? `error: ${e.message}` : e);
  process.exit(1);
}
