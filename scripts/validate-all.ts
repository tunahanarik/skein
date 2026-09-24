/** Runs every read-only validation in sequence (to stay under the public RPC's rate limit). */
import { Report } from "./lib/report.js";
import { validateAssets } from "./validate-assets.js";
import { validateMorpho } from "./validate-morpho.js";
import { validateNetwork } from "./validate-network.js";
import { validateOracles } from "./validate-oracles.js";
import { validatePendle } from "./validate-pendle.js";
import { validatePortfolio } from "./validate-portfolio.js";
import { validateOpportunities } from "./validate-opportunities.js";
import { validateCombined, validatePendleAdapter } from "./validate-pendle-adapter.js";
import { validateIntelligence } from "./validate-intelligence.js";
import { validateCombinedTrade, validateUniswap } from "./validate-uniswap.js";

const steps: [string, (r: Report) => Promise<Report>][] = [
  ["network", validateNetwork],
  ["assets", validateAssets],
  ["oracles", validateOracles],
  ["morpho", validateMorpho],
  ["pendle", validatePendle],
  ["portfolio-validation", validatePortfolio], // Phase 1
  ["opportunities-validation", validateOpportunities], // Phase 2
  ["pendle-adapter-validation", validatePendleAdapter], // Phase 3
  ["combined-validation", validateCombined], // Phase 3
  ["uniswap-validation", validateUniswap], // Phase 4
  ["combined-trade-validation", validateCombinedTrade], // Phase 4
  ["intelligence-validation", validateIntelligence], // Phase 5
];

let failed = 0;
for (const [name, run] of steps) {
  console.log(`\n=== ${name} ===`);
  const report = new Report(name);
  try {
    await run(report);
  } catch (e) {
    report.fail(`${name} crashed`, (e as Error).message.split("\n")[0] ?? "error");
  }
  if (report.finish() !== 0) failed++;
}
console.log(failed ? `\n${failed} validation group(s) failed` : "\nall validation groups passed");
process.exitCode = failed ? 1 : 0;
