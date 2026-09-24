/**
 * Generic lifecycle helpers (not protocol-specific). The reference clock is always the pinned
 * block's timestamp, so "expired" means expired at the block every other value was read at.
 */
import { classifyFreshness } from "../config/freshness.js";
import type { EntryBlocker, Lifecycle, Measured } from "../model/opportunity.js";
import type { DataSource } from "../model/provenance.js";

const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString();

/** Open-ended venue (lending market, vault): no maturity; enterable unless blocked. */
export function openEndedLifecycle(block: { number: bigint; timestamp: bigint }, blockers: EntryBlocker[] = []): Lifecycle {
  return {
    state: blockers.includes("MARKET_INACTIVE") ? "INACTIVE" : "ACTIVE",
    maturity: null,
    secondsToMaturity: null,
    timeReference: { kind: "BLOCK_TIMESTAMP", blockNumber: block.number, timestamp: iso(block.timestamp) },
    canEnter: blockers.length === 0,
    blockers,
  };
}

/**
 * Maturity-based venue. `expiry` null → UNKNOWN (never assumed active).
 * Active strictly before maturity; at or after maturity the venue is EXPIRED.
 */
export function maturityLifecycle(
  expiry: bigint | null,
  expirySource: DataSource,
  block: { number: bigint; timestamp: bigint },
  nowS: number,
  extraBlockers: EntryBlocker[] = [],
): Lifecycle {
  const timeReference = { kind: "BLOCK_TIMESTAMP" as const, blockNumber: block.number, timestamp: iso(block.timestamp) };
  if (expiry === null || expiry <= 0n) {
    return { state: "UNKNOWN", maturity: null, secondsToMaturity: null, timeReference, canEnter: null, blockers: ["STATE_UNKNOWN", ...extraBlockers] };
  }
  const seconds = Number(expiry - block.timestamp);
  const expired = seconds <= 0;
  const maturity: Measured<string> = {
    value: iso(expiry),
    origin: "SUPPLIED",
    source: expirySource,
    observedAt: iso(block.timestamp),
    // Maturity is immutable configuration; its "age" is the age of the read.
    freshness: classifyFreshness("PROTOCOL_MARKET_CONFIG", Number(block.timestamp), nowS),
    verification: expirySource.type === "ONCHAIN" ? "VERIFIED_ONCHAIN" : "VERIFIED_OFFICIAL_API",
  };
  const blockers: EntryBlocker[] = [...(expired ? (["EXPIRED"] as EntryBlocker[]) : []), ...extraBlockers];
  return { state: expired ? "EXPIRED" : extraBlockers.includes("MARKET_INACTIVE") ? "INACTIVE" : "ACTIVE", maturity, secondsToMaturity: seconds, timeReference, canEnter: blockers.length === 0, blockers };
}
