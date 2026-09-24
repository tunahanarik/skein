import type { Address, PublicClient } from "viem";
import type { AssetRef, Opportunity, OpportunityCategory } from "../model/opportunity.js";
import type { DataSource, Metric } from "../model/provenance.js";

/** Shared, injected dependencies. Adapters never build their own clients or read env. */
export interface AdapterContext {
  chainId: number;
  client: PublicClient;
  fetch: typeof fetch;
  now: () => Date;
  signal?: AbortSignal;
}

export interface AdapterError {
  /** Which part failed, e.g. "morpho-api:markets" or "onchain:market(0x…)". */
  scope: string;
  message: string;
  /** Degraded = data returned but partial (e.g. rewards missing); fatal = nothing usable. */
  severity: "DEGRADED" | "FATAL";
}

/** Every call returns what it could get plus what failed. Adapters don't throw for data gaps. */
export interface AdapterResult<T> {
  data: T;
  errors: AdapterError[];
  sources: DataSource[];
}

export interface UserPosition {
  protocolId: string;
  opportunityId: string;
  kind: "SUPPLY" | "BORROW" | "COLLATERAL" | "VAULT_SHARES" | "LP" | "PT" | "YT";
  asset: AssetRef;
  amountRaw: bigint;
  valueUsd: Metric<number>;
  /** Lending only: protocol-reported or computed health factor. */
  healthFactor: Metric<number>;
}

/**
 * One adapter per protocol. Methods are optional: an adapter implements only what the
 * protocol genuinely supports, and `capabilities` says so up front so the engine never has
 * to probe by calling. No method signs, approves or sends anything.
 */
export interface ProtocolAdapter {
  readonly id: string; // matches src/config/protocols.ts
  readonly categories: readonly OpportunityCategory[];
  readonly capabilities: {
    opportunities: boolean;
    assetOpportunities: boolean;
    userPositions: boolean;
    marketDetails: boolean;
  };

  /** Full catalogue (used to warm a cache). */
  getOpportunities?(ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>>;
  /** Opportunities where `asset` is an input, collateral or borrowable asset. */
  getAssetOpportunities?(asset: AssetRef, ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>>;
  getUserPositions?(user: Address, ctx: AdapterContext): Promise<AdapterResult<UserPosition[]>>;
  getMarketDetails?(venueRef: string, ctx: AdapterContext): Promise<AdapterResult<Opportunity | null>>;
}
