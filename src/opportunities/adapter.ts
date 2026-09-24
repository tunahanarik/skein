/**
 * Protocol adapter contract. The Opportunity Engine only ever talks to adapters through this
 * interface; protocol logic (APIs, contracts, normalization) stays inside each adapter.
 *
 * Capabilities are declared up front so the engine never probes by calling. Optional methods
 * are implemented only when the protocol genuinely supports them. Nothing here executes.
 */
import type { Address } from "viem";
import type { ChainReader } from "../chain/reader.js";
import type { FreshnessInfo, FreshnessStatus } from "../config/freshness.js";
import type { Opportunity, OpportunityCategory } from "../model/opportunity.js";
import type { Position } from "../model/position.js";
import type { QuoteResult, TradeRoute } from "../model/trade.js";
import type { Warning } from "../model/warnings.js";
import type { PriceService } from "../pricing/priceService.js";
import type { AssetRegistry } from "../registry/registry.js";

export interface AdapterCapabilities {
  /** Can list all of its opportunities. */
  discovery: boolean;
  /** Can answer "opportunities for asset X" more efficiently than filtering discovery output. */
  assetFiltering: boolean;
  userPositions: boolean;
  /** Can fetch a single opportunity by id. */
  singleOpportunity: boolean;
  /** Always false in this codebase: read-only. */
  execution: false;
  /** Phase 4: can produce read-only INDICATIVE quotes for routes made only of its own markets. */
  quotes?: boolean;
}

export interface AdapterContext {
  chainId: number;
  reader: ChainReader;
  registry: AssetRegistry;
  prices: PriceService;
  now: () => Date;
  /** Block every onchain read in this run is pinned to. */
  blockNumber: bigint;
  blockTimestamp: bigint;
}

export type ResultStatus = "COMPLETE" | "PARTIAL" | "UNKNOWN";

export interface AdapterIssue {
  /** Which part failed, e.g. "morpho-api:markets", "market 0xabc…". */
  scope: string;
  message: string;
  /** DEGRADED = partial data returned; FATAL = nothing usable from this scope. */
  severity: "DEGRADED" | "FATAL";
}

export interface AdapterResult<T> {
  data: T;
  status: ResultStatus;
  issues: AdapterIssue[];
  warnings: Warning[];
  timingsMs: Record<string, number>;
  /** Freshness of the adapter's underlying state (e.g. a stale-cache fallback). */
  dataFreshness?: FreshnessInfo;
}

export interface OpportunityAdapter {
  readonly protocol: { id: string; name: string };
  readonly categories: readonly OpportunityCategory[];
  readonly capabilities: AdapterCapabilities;
  supportsCategory(category: OpportunityCategory): boolean;

  getOpportunities?(ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>>;
  /** `assetKey` is a registry key (`chainId:address`), never a symbol. */
  getAssetOpportunities?(assetKey: string, ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>>;
  getOpportunity?(id: string, ctx: AdapterContext): Promise<AdapterResult<Opportunity | null>>;
  getUserPositions?(wallet: Address, ctx: AdapterContext): Promise<AdapterResult<Position[]>>;
  /** Read-only indicative quote (no calldata). Only for routes whose markets all belong to this adapter. */
  quoteRoute?(route: TradeRoute, amountInRaw: bigint, ctx: AdapterContext): Promise<QuoteResult>;
}

export function worstFreshness(list: readonly FreshnessInfo[], fallback: FreshnessInfo): FreshnessInfo {
  const rank: Record<FreshnessStatus, number> = { FRESH: 0, AGING: 1, STALE: 2, UNKNOWN: 3 };
  return list.reduce((w, f) => (rank[f.status] > rank[w.status] ? f : w), list[0] ?? fallback);
}

export function combineStatus(statuses: readonly ResultStatus[]): ResultStatus {
  if (statuses.length === 0) return "UNKNOWN";
  if (statuses.every((s) => s === "COMPLETE")) return "COMPLETE";
  if (statuses.every((s) => s === "UNKNOWN")) return "UNKNOWN";
  return "PARTIAL";
}
