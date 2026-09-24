/**
 * Domain-level filtering and deterministic sorting. Objective only: no "safe"/"best" filters.
 * Yield sorting compares ONE yield metric type at a time and requires an explicit direction,
 * because a higher BORROW_APY is a higher cost, not a better opportunity.
 */
import type { Opportunity, OpportunityCategory, YieldMetric, YieldMetricType } from "../model/opportunity.js";
import type { VerificationStatus } from "../model/verification.js";

export type AssetRole = "PRIMARY" | "INPUT" | "COLLATERAL" | "BORROW" | "ANY";

export interface OpportunityFilter {
  categories?: readonly OpportunityCategory[];
  protocols?: readonly string[];
  /** Registry key (`chainId:address`). */
  assetKey?: string;
  assetRole?: AssetRole;
  /** Minimum available liquidity in USD (1e18-scaled). Opportunities without a USD figure are excluded. */
  minLiquidityUsdE18?: bigint;
  minTvlUsdE18?: bigint;
  verificationStatuses?: readonly VerificationStatus[];
  /** Only opportunities whose every asset is canonical. */
  canonicalOnly?: boolean;
  /** Only opportunities the protocol itself lists (Morpho `listed`), where known. */
  protocolListedOnly?: boolean;
}

export type SortSpec =
  | { by: "YIELD"; yieldType: YieldMetricType; direction: "ASC" | "DESC" }
  | { by: "TVL_USD" | "LIQUIDITY_USD"; direction?: "ASC" | "DESC" }
  | { by: "UTILIZATION"; direction: "ASC" | "DESC" };

function hasAsset(o: Opportunity, key: string, role: AssetRole): boolean {
  const k = key.toLowerCase();
  const inList = (l: { key: string }[]) => l.some((a) => a.key.toLowerCase() === k);
  switch (role) {
    case "PRIMARY":
      return o.primaryAsset.key.toLowerCase() === k;
    case "INPUT":
      return inList(o.inputAssets);
    case "COLLATERAL":
      return inList(o.collateralAssets);
    case "BORROW":
      return inList(o.borrowAssets);
    case "ANY":
      return o.primaryAsset.key.toLowerCase() === k || inList(o.inputAssets) || inList(o.outputAssets) || inList(o.collateralAssets) || inList(o.borrowAssets);
  }
}

export function filterOpportunities(list: readonly Opportunity[], f: OpportunityFilter = {}): Opportunity[] {
  return list.filter((o) => {
    if (f.categories && !f.categories.includes(o.category)) return false;
    if (f.protocols && !f.protocols.includes(o.protocol.id)) return false;
    if (f.assetKey && !hasAsset(o, f.assetKey, f.assetRole ?? "PRIMARY")) return false;
    if (f.minLiquidityUsdE18 !== undefined) {
      const usd = o.availableLiquidity?.value.usd?.e18;
      if (usd === undefined || usd < f.minLiquidityUsdE18) return false;
    }
    if (f.minTvlUsdE18 !== undefined) {
      const usd = o.tvl?.value.usd?.e18;
      if (usd === undefined || usd < f.minTvlUsdE18) return false;
    }
    if (f.verificationStatuses && !f.verificationStatuses.includes(o.verificationStatus)) return false;
    if (f.canonicalOnly && !o.risk.allAssetsCanonical) return false;
    if (f.protocolListedOnly && !(o.risk.protocolListed.known && o.risk.protocolListed.value)) return false;
    return true;
  });
}

/** The single metric of `type` on an opportunity, or null (0 or several → not comparable). */
export function yieldOf(o: Opportunity, type: YieldMetricType): YieldMetric | null {
  const m = o.yields.filter((y) => y.type === type);
  return m.length === 1 ? m[0]! : null;
}

export interface SortResult {
  sorted: Opportunity[];
  /** Opportunities without a comparable value, appended after the ranked ones (by id). */
  notComparable: string[];
}

/**
 * Deterministic: ties and missing values are ordered by id. Opportunities lacking the sort
 * metric are never ranked as if they had 0; they go after the ranked set and are listed.
 */
export function sortOpportunities(list: readonly Opportunity[], spec: SortSpec): SortResult {
  const key = (o: Opportunity): bigint | null => {
    switch (spec.by) {
      case "YIELD":
        return yieldOf(o, spec.yieldType)?.value ?? null;
      case "TVL_USD":
        return o.tvl?.value.usd?.e18 ?? null;
      case "LIQUIDITY_USD":
        return o.availableLiquidity?.value.usd?.e18 ?? null;
      case "UTILIZATION":
        return o.utilization?.value ?? null;
    }
  };
  const dir = spec.direction ?? "DESC";
  const ranked = list.filter((o) => key(o) !== null);
  const rest = list.filter((o) => key(o) === null).sort((a, b) => a.id.localeCompare(b.id));
  ranked.sort((a, b) => {
    const d = key(a)! - key(b)!;
    if (d !== 0n) return (d > 0n ? 1 : -1) * (dir === "ASC" ? 1 : -1);
    return a.id.localeCompare(b.id);
  });
  return { sorted: [...ranked, ...rest], notComparable: rest.map((o) => o.id) };
}
