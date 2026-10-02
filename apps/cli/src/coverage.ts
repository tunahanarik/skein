/**
 * Developer CLI: coverage matrix — for every canonical asset, which intents are usable today.
 *
 *   pnpm coverage          table
 *   pnpm coverage --json   machine-readable (docs/coverage.md)
 */
import { createRuntime } from "@skein/runtime/runtime";
import { clean, toJson } from "./lib/intelligence.js";

const argv = process.argv.slice(2);
const rt = createRuntime();
const t0 = performance.now();
const rows = await rt.intelligence.getCoverage();
if (argv.includes("--json")) console.log(toJson({ generatedAt: new Date().toISOString(), rows }));
else {
  const mark = (d: string) => (d === "ACTIONABLE" ? "Y" : d === "LIMITED_ONLY" ? "L" : d === "INFORMATIONAL_ONLY" ? "i" : ".");
  console.log(`COVERAGE  ${rows.length} canonical assets   (Y actionable · L limited only · i informational only · . none)`);
  console.log(`${"asset".padEnd(10)}${"type".padEnd(13)}TRD EARN BRW LIQ  ${"act".padStart(4)}${"lim".padStart(5)}${"hid".padStart(6)}  protocols`);
  const sorted = [...rows].sort((a, b) => b.actionable - a.actionable || a.asset.symbol.localeCompare(b.asset.symbol));
  for (const r of sorted) {
    const d = r.capabilities.detail;
    console.log(`${clean(r.asset.symbol).padEnd(10)}${(r.asset.registryType ?? "").padEnd(13)} ${mark(d.TRADE)}   ${mark(d.EARN)}    ${mark(d.BORROW)}   ${mark(d.LIQUIDITY)}  ${String(r.actionable).padStart(4)}${String(r.limited).padStart(5)}${String(r.hidden + r.unavailable).padStart(6)}  ${r.protocols.join(", ")}`);
  }
  const count = (k: "canTrade" | "canEarn" | "canBorrowAgainst" | "canProvideLiquidity") => rows.filter((r) => r.capabilities[k]).length;
  console.log(`\nassets with an actionable intent: trade ${count("canTrade")} · earn ${count("canEarn")} · borrow ${count("canBorrowAgainst")} · liquidity ${count("canProvideLiquidity")}   (${Math.round(performance.now() - t0)} ms)`);
}
