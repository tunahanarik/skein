/**
 * Developer CLI for the Phase 5 product read API (read-only).
 *
 *   pnpm asset NVDA                          what can be done with NVDA (PRODUCT mode)
 *   pnpm asset NVDA --json                   machine-readable (bigints as strings)
 *   pnpm asset NVDA --to USDG --amount 1     indicative quotes for exactly 1 NVDA → USDG
 *   pnpm asset NVDA --debug                  DEBUG mode: every excluded item with its reasons
 *
 * Symbols resolve to canonical registry assets only; ambiguous symbols need the address.
 */
import { ValidationError } from "@skein/core/lib/validation";
import { createRuntime } from "@skein/runtime/runtime";
import { argOf, printIntelligence, resolveCanonical, toJson } from "./lib/intelligence.js";

const argv = process.argv.slice(2);
try {
  const input = argv.find((a, i) => !a.startsWith("--") && !["--to", "--amount"].includes(argv[i - 1] ?? ""));
  const rt = createRuntime();
  const registry = await rt.getRegistry();
  const asset = resolveCanonical(registry, input, "asset");
  const to = argOf(argv, "--to");
  const amount = argOf(argv, "--amount");
  if (amount !== undefined && to === undefined) throw new ValidationError("--amount requires --to");
  const t0 = performance.now();
  const v = await rt.intelligence.getAssetIntelligence(asset, {
    mode: argv.includes("--debug") ? "DEBUG" : "PRODUCT",
    ...(to ? { tradeTarget: resolveCanonical(registry, to, "--to") } : {}),
    ...(amount !== undefined ? { tradeAmount: amount } : {}),
  });
  if (argv.includes("--json")) console.log(toJson(v));
  else {
    printIntelligence(v);
    console.log(`\n(${Math.round(performance.now() - t0)} ms; quotes are indicative, never a guarantee; nothing here is executable)`);
  }
} catch (e) {
  console.error(e instanceof ValidationError ? `error: ${e.message}` : e);
  process.exit(1);
}
