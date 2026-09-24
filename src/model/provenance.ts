import type { Address } from "viem";
import { weakestStatus, type VerificationStatus } from "./verification.js";

/** Where a value physically came from. */
export type SourceType =
  | "ONCHAIN" // eth_call / logs against a chain RPC
  | "OFFICIAL_API" // issuer's or protocol's own API (Robinhood /rhj, Morpho API, Pendle API ...)
  | "OFFICIAL_DOCS" // docs page or official deployment registry (e.g. a GitHub deployments JSON)
  | "THIRD_PARTY_API" // GeckoTerminal, DexScreener, DefiLlama ...
  | "DERIVED"; // computed by us from other sourced values

export interface DataSource {
  type: SourceType;
  /** Stable provider id, e.g. "robinhood-chain-rpc", "robinhood-rhj-api", "morpho-api", "chainlink". */
  provider: string;
  /** Endpoint or document the value was read from. Never contains secrets or user data. */
  url?: string;
  chainId?: number;
  contract?: Address;
  /** Function, GraphQL field or JSON path, e.g. "latestRoundData()" or "markets.items[].state.supplyApy". */
  method?: string;
  /** Block the onchain read was pinned to. */
  blockNumber?: bigint;
  /** When we fetched it (ISO-8601). */
  observedAt: string;
  /**
   * When the source itself says the value was produced (Chainlink updatedAt, API generatedAt).
   * Freshness is judged on this when present: a value fetched now can still be hours old.
   */
  sourceTimestamp?: string;
}

/**
 * A value together with its evidence. `origin` answers "was this supplied by the protocol
 * or calculated by us?"; `inputs` lets a derived value be traced back to its parts.
 */
export interface Sourced<T> {
  value: T;
  origin: "SUPPLIED" | "COMPUTED";
  source: DataSource;
  verification: VerificationStatus;
  /** For COMPUTED values: the sourced inputs and the formula id used. */
  inputs?: readonly Sourced<unknown>[];
  formula?: string;
}

/** A metric we could not obtain is `null`, never a fabricated 0. */
export type Metric<T> = Sourced<T> | null;

export function supplied<T>(value: T, source: DataSource, verification: VerificationStatus): Sourced<T> {
  return { value, origin: "SUPPLIED", source, verification };
}

/**
 * Wrap a value we calculated. Its verification is the weakest of its inputs, so deriving
 * can never upgrade evidence.
 */
export function computed<T>(
  value: T,
  formula: string,
  inputs: readonly Sourced<unknown>[],
  observedAt: string,
): Sourced<T> {
  const sourceTimes = inputs
    .map((i) => i.source.sourceTimestamp ?? i.source.observedAt)
    .sort(); // ISO strings sort chronologically
  const oldest = sourceTimes[0];
  return {
    value,
    origin: "COMPUTED",
    source: {
      type: "DERIVED",
      provider: "defi-router",
      method: formula,
      observedAt,
      // a derived value is only as fresh as its oldest input
      ...(oldest !== undefined ? { sourceTimestamp: oldest } : {}),
    },
    verification: weakestStatus(inputs.map((i) => i.verification)),
    inputs,
    formula,
  };
}
