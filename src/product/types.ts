/**
 * Product read model (Phase 5). A protocol-independent PROJECTION of raw Opportunities for a
 * future frontend: "I own this asset. What can I actually do with it?"
 *
 * Raw `Opportunity` stays the source of truth (RAW mode); product cards are derived from it
 * (PRODUCT mode) and every exclusion is explained (DEBUG mode). Nothing here is executable, and no
 * field is a subjective score: usability comes from objective conditions, ordering from documented
 * per-category comparators (docs/product-ranking.md, docs/product-usability.md).
 */
import type { FreshnessStatus } from "../config/freshness.js";
import type { PriceImpactClass } from "../config/tradeQuality.js";
import type { Fixed18 } from "../lib/fixed.js";
import type { AssetRef, OpportunityCategory, TokenAmount, UsdAmount, YieldMetricType } from "../model/opportunity.js";
import type { SourceType } from "../model/provenance.js";
import type { RouteKind } from "../model/trade.js";
import type { VerificationStatus } from "../model/verification.js";

export type ProductMode = "PRODUCT" | "DEBUG";

/** Top-level user intents. Never ranked against each other. */
export type ProductCategory = "TRADE" | "EARN" | "BORROW" | "LIQUIDITY";
/** Product subcategory (the unit of ranking). Raw category is kept in `rawCategory`. */
export type ProductSubcategory = "TRADE" | "LEND" | "VAULT" | "FIXED_YIELD" | "YIELD" | "COLLATERAL" | "LP";

/**
 * Usability — separate from verification.
 *   ACTIONABLE         can be done now; no objective limitation found
 *   LIMITED            can be done, with an objective limitation (liquidity, impact, stale data …)
 *   INFORMATIONAL      shown for context; its main purpose cannot be fulfilled now (e.g. collateral
 *                      market with nothing to borrow)
 *   HIDDEN_BY_DEFAULT  evidence problem (conflict, non-canonical asset, dust, unresolved semantics,
 *                      extreme price impact …) — debug only
 *   UNAVAILABLE        cannot be entered now (expired, deposits disabled, paused, inactive) — debug only
 */
export type Usability = "ACTIONABLE" | "LIMITED" | "INFORMATIONAL" | "HIDDEN_BY_DEFAULT" | "UNAVAILABLE";

export type UsabilityReason =
  // hidden (evidence)
  | "DATA_CONFLICT"
  | "NON_CANONICAL_ASSET"
  | "INSUFFICIENT_VERIFICATION"
  | "DUST_LIQUIDITY"
  | "UNRESOLVED_YIELD_SEMANTICS"
  | "LIQUIDITY_UNVERIFIED"
  | "ENTRY_ROUTE_UNKNOWN"
  | "ENTRY_STATE_UNKNOWN"
  | "EXTREME_PRICE_IMPACT"
  // unavailable (lifecycle)
  | "EXPIRED"
  | "INACTIVE"
  | "DEPOSIT_DISABLED"
  | "PROTOCOL_PAUSED"
  // informational
  | "ZERO_BORROWABLE_LIQUIDITY"
  // limited
  | "LOW_LIQUIDITY"
  | "ZERO_LIQUIDITY"
  | "LOW_ROUTE_LIQUIDITY"
  | "ELEVATED_PRICE_IMPACT"
  | "HIGH_PRICE_IMPACT"
  | "PRICE_IMPACT_UNKNOWN"
  | "STALE_DATA"
  | "QUOTE_STALE";

/** Facts worth showing that do NOT limit usability (e.g. "not listed by the protocol's app"). */
export type ProductNote =
  | "PROTOCOL_UNLISTED"
  | "ORACLE_ASSUMES_LOAN_PEG"
  | "ACCOUNTING_UNIT_NOT_TOKEN"
  | "IMPLIED_RATE_NOT_GUARANTEED"
  | "UNDERLYING_UNVERIFIED"
  | "YIELD_TOKEN_DECAYS_TO_ZERO"
  | "RESERVES_INCLUDE_UNCOLLECTED_FEES"
  | "MARKET_PRICE_DIVERGENCE"
  | "REWARDS_MAY_BE_INCOMPLETE"
  | "VOLUME_UNKNOWN";

export interface UsabilityResult {
  status: Usability;
  reasons: UsabilityReason[];
  notes: ProductNote[];
  /** Id of the policies used (eligibility, trade quality). */
  policies: string[];
}

export interface SourceSummary {
  provider: string; // display name, e.g. "Morpho", "Robinhood Chain"
  type: SourceType;
}

export interface MetricView {
  type: YieldMetricType;
  side: "EARN" | "PAY";
  value: Fixed18;
  display: string; // percent with 2–4 decimals, e.g. "7.29%"
  basis: "VARIABLE" | "FIXED" | "IMPLIED";
  origin: "SUPPLIED" | "COMPUTED";
  observedAt: string;
  freshness: FreshnessStatus;
  label: string;
  /** What the rate is denominated in: an asset key, or `accounting:<key>` for non-token accounting units. Rates compare only within one unit. */
  unit: string | null;
}

export interface RankingFactors {
  /** Name of the comparator (docs/product-ranking.md). */
  comparator: string;
  primary: string;
  secondary: string[];
  position: number;
  context?: Record<string, string>;
}

export interface BorrowCapacity {
  kind: "THEORETICAL_LIMIT";
  /** Always null: no recommended amount or safety buffer is modelled. */
  recommendedBorrow: null;
  collateral: { amount: TokenAmount; usd: UsdAmount | null };
  maxBorrow: { asset: AssetRef; amount: TokenAmount; usd: UsdAmount | null } | null;
  lltv: Fixed18;
  formula: string;
  caveat: string;
  unavailableReason: string | null;
  /**
   * What could be borrowed right now: min(protocol limit, the market's available liquidity), exact
   * integer math. Still at the liquidation threshold — not a recommendation.
   */
  borrowableNow: { amount: TokenAmount; usd: UsdAmount | null; cappedBy: "PROTOCOL_LIMIT" | "MARKET_LIQUIDITY" } | null;
}

export interface FixedYieldView {
  impliedApy: MetricView | null;
  maturity: string | null;
  secondsToMaturity: number | null;
  daysToMaturity: string | null;
  accountingUnit: { assetType: string; description: string };
  ptDiscount: Fixed18 | null;
  conditions: string[];
}

export interface TradeRouteView {
  routeId: string;
  kind: RouteKind;
  path: AssetRef[];
  markets: { marketId: string; protocol: string; feePpm: number | null; tvlUsd: UsdAmount | null }[];
  combinedFeePpm: number | null;
  routeLiquidityUsd: UsdAmount | null;
  allVerified: boolean;
  volume24h: "UNKNOWN";
}

export interface TradeQuoteView {
  kind: "INDICATIVE_QUOTE";
  input: TokenAmount & { asset: AssetRef };
  expectedOutput: TokenAmount & { asset: AssetRef };
  effectivePrice: Fixed18;
  priceImpact: Fixed18 | null;
  priceImpactClass: PriceImpactClass;
  fees: { asset: AssetRef; amount: TokenAmount }[] | null;
  blockNumber: bigint;
  quotedAt: string;
  freshness: FreshnessStatus;
  /** Never a guarantee; no minimum output is given. */
  guarantee: "NONE";
}

export interface ProductCard {
  /** Deterministic product identity (docs/asset-intelligence.md "card identity"). */
  cardId: string;
  category: ProductCategory;
  subcategory: ProductSubcategory;
  rawCategory: OpportunityCategory | "TRADE_ROUTE";
  protocol: { id: string; name: string };
  /** Neutral action label, e.g. "Supply USDG" — never "best", "safe", "guaranteed". */
  actionLabel: string;
  context: string | null;
  asset: AssetRef;
  counterAsset: AssetRef | null;
  headline: MetricView | null;
  metrics: MetricView[];
  liquidity: { kind: string; usd: UsdAmount | null } | null;
  tvlUsd: UsdAmount | null;
  maturity: string | null;
  lltv: Fixed18 | null;
  usability: UsabilityResult;
  verification: VerificationStatus;
  freshness: { status: FreshnessStatus; oldestObservedAt: string | null };
  sources: SourceSummary[];
  ranking: RankingFactors | null;
  borrowCapacity?: BorrowCapacity;
  fixedYield?: FixedYieldView;
  trade?: { route: TradeRouteView; quote: TradeQuoteView | null; quoteUnavailableReason?: string };
  /** Raw opportunities behind this card (RAW mode ids). */
  sourceOpportunityIds: string[];
}

export interface CategoryView {
  category: ProductCategory;
  subcategories: {
    subcategory: ProductSubcategory;
    comparator: string;
    cards: ProductCard[];
    /** TRADE only: visible routes per target beyond PRODUCT_MAX_ROUTES_PER_TARGET (not shown in PRODUCT mode). */
    moreRoutes?: { target: string; shown: number; total: number }[];
  }[];
}

export interface OpportunityCounts {
  discovered: number;
  verified: number;
  actionable: number;
  limited: number;
  informational: number;
  hidden: number;
  unavailable: number;
  hiddenByReason: Partial<Record<UsabilityReason, number>>;
}

export type DataQualityStatus = "COMPLETE" | "PARTIAL" | "STALE" | "UNKNOWN";
export interface DataQuality {
  status: DataQualityStatus;
  reasons: { code: string; protocol?: string; detail: string }[];
}

export interface FreshnessSummary {
  oldestCriticalDataAt: string | null;
  newestDataAt: string | null;
  staleSources: { provider: string; status: FreshnessStatus; ageSeconds: number | null; what: string }[];
  /** Measured at response time (never refreshed by rebuilding a projection). */
  evaluatedAt: string;
}

export interface Capabilities {
  canTrade: boolean;
  canEarn: boolean;
  canBorrowAgainst: boolean;
  canProvideLiquidity: boolean;
  /**
   * Per intent: an ACTIONABLE item exists / only LIMITED items / only INFORMATIONAL items (visible,
   * not usable now, e.g. zero borrowable liquidity) / nothing visible.
   */
  detail: Record<ProductCategory, "ACTIONABLE" | "LIMITED_ONLY" | "INFORMATIONAL_ONLY" | "NONE">;
}

export interface BalanceView {
  rawBalance: bigint;
  decimals: number;
  displayBalance: string;
  /** Stock Tokens (Phase 1 semantics, untouched): multiplier and share-equivalent. */
  stock: { uiMultiplier: string; displayShareBalance: string; note: string } | null;
  valueUsd: UsdAmount | null;
}

export interface PriceView {
  kind: "PORTFOLIO_PRICE";
  usd: string | null;
  method: string | null;
  observedAt: string | null;
  freshness: FreshnessStatus;
  unpricedReason: string | null;
}

export type EmptyState = "UNKNOWN_ASSET" | "NON_CANONICAL_ASSET" | "NO_OPPORTUNITIES" | "NO_USABLE_OPPORTUNITIES" | "NO_BALANCE" | "UNPRICED" | "ADAPTERS_UNAVAILABLE";

export interface AssetIntelligence {
  mode: ProductMode;
  chainId: number;
  asset: AssetRef | null;
  query: { asset: string; tradeTarget: string | null; tradeAmount: string | null };
  balance: BalanceView | null;
  price: PriceView | null;
  categories: CategoryView[];
  /** Other trade destinations beyond the default targets (counts only; RAW has them all). */
  otherTradeDestinations: { direct: number; oneHop: number };
  /** Every asset reachable from this one through verified routes (DIRECT or ONE_HOP), for a target picker. Empty = no route at all. */
  tradeTargets: { key: string; symbol: string; kind: "DIRECT" | "ONE_HOP" }[];
  summary: {
    capabilities: Capabilities;
    counts: OpportunityCounts;
    productCards: number;
    protocols: string[];
    allDiscoveredProtocols: string[];
  };
  emptyStates: EmptyState[];
  dataQuality: DataQuality;
  freshness: FreshnessSummary;
  /** DEBUG mode only: every card that the product view hides, with reasons. */
  excluded?: ProductCard[];
  blockNumber: bigint;
  generatedAt: string;
}

export interface PortfolioIntelligence {
  chainId: number;
  /** Address is only echoed back to the caller; it is never logged, persisted or sent to protocol APIs. */
  wallet: string;
  portfolioValueUsd: string | null;
  pricedValueUsd: string;
  supportedAssetValueUsd: string;
  unsupportedAssetValueUsd: string;
  unpricedAssetCount: number;
  assets: AssetIntelligence[];
  unsupportedAssets: { asset: AssetRef | { symbol: string; key: string }; reason: string; valueUsd: string | null }[];
  opportunityCounts: OpportunityCounts;
  dataQuality: DataQuality;
  freshness: FreshnessSummary;
  blockNumber: bigint;
  generatedAt: string;
}

export interface CoverageRow {
  asset: AssetRef;
  portfolioPriceUsd: string | null;
  priceFreshness: FreshnessStatus | null;
  byRawCategory: Record<"TRADE" | "LEND" | "VAULT" | "COLLATERAL" | "FIXED_YIELD" | "YIELD" | "LP", number>;
  actionable: number;
  limited: number;
  informational: number;
  hidden: number;
  unavailable: number;
  protocols: string[];
  capabilities: Capabilities;
}
