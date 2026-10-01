/** Local rate history: throttled, eligible-only, persisted, reloaded, expired points dropped. */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Opportunity } from "../../src/model/opportunity.js";
import { RateHistory, RECORD_EVERY_MS, RETENTION_MS } from "../../src/server/rateHistory.js";

const opp = (id: string, v: bigint, eligible = true) =>
  ({ id, category: "LEND", eligibility: { eligibleForDefaultDisplay: eligible, excludedBy: [], advisories: [], policy: "x" }, yields: [{ type: "SUPPLY_APY", value: v }], tvl: null }) as unknown as Opportunity;

describe("RateHistory", () => {
  it("records eligible headline rates at most every RECORD_EVERY_MS and reloads them from disk", () => {
    const file = join(mkdtempSync(join(tmpdir(), "rh-")), "rates.jsonl");
    let now = 1_000_000_000_000;
    const h = new RateHistory(file, () => now);
    expect(h.record([opp("a", 5n * 10n ** 16n), opp("b", 1n, false)], now)).toBe(1);
    expect(h.record([opp("a", 6n * 10n ** 16n)], now + 1000)).toBe(0); // throttled
    now += RECORD_EVERY_MS;
    expect(h.record([opp("a", 6n * 10n ** 16n)], now)).toBe(1);
    expect(h.get("a").points.map((p) => p.v)).toEqual([String(5n * 10n ** 16n), String(6n * 10n ** 16n)]);
    expect(h.get("b").points).toEqual([]);
    const again = new RateHistory(file, () => now);
    expect(again.get("a").points).toHaveLength(2);
    // retention: reload far in the future drops everything and compacts the file
    const later = new RateHistory(file, () => now + RETENTION_MS + 1);
    expect(later.get("a").points).toHaveLength(0);
    expect(readFileSync(file, "utf8")).toBe("");
  });
});
