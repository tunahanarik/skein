/**
 * PortfolioAsset × Opportunity → PortfolioOpportunity. Protocol-independent: uses only the
 * canonical Opportunity fields (liquidation terms, liquidity, yields), never adapter details.
 *
 * All amounts are bigint. The only "maximum borrow" we compute is the PROTOCOL maximum at the
 * liquidation threshold — by definition a position at that size is liquidatable after any
 * adverse move. It is labelled as such and is not a suggested or safe amount.
 */
import type { AmountWithUsd, EntryRequirement, Lifecycle, Opportunity, YieldMetric, YieldMetricType } from "../model/opportunity.js";
import type { PortfolioAsset } from "../portfolio/types.js";
import { mulDivDown, wMulDown } from "../lib/fixed.js";
import { formatFixed, usdValueE18, USD_DECIMALS } from "../lib/units.js";
import type { UsdPrice } from "../pricing/types.js";

export interface Holding {
  assetKey: string;
  rawBalance: bigint;
  displayBalance: string | null;
  valueUsd: string | null;
}

export type PortfolioOpportunityContext =
  | {
      kind: "COLLATERAL";
      collateralHeld: AmountWithUsd;
      /**
       * Largest debt the protocol's own rule allows for the held collateral at the pinned block:
       *   floor(floor(collateral × price.raw / price.scale) × LLTV / 1e18)
       * A position at this size is AT the liquidation threshold. NOT a safe borrow amount.
       */
      protocolMaximumBorrow: AmountWithUsd | null;
      /** min(protocolMaximumBorrow, available liquidity). Still not a safe amount. */
      protocolMaximumBorrowLiquidityCapped: AmountWithUsd | null;
      formula: string;
      caveat: string;
      unavailableReason: string | null;
    }
  | {
      kind: "SUPPLY";
      suppliable: AmountWithUsd;
      /** The opportunity's own EARN metric used for context (e.g. SUPPLY_APY), unchanged. */
      referenceYield: YieldMetric | null;
      caveat: string;
    }
  | {
      /** Maturity-based or exposure positions (FIXED_YIELD, YIELD, LP). */
      kind: "ENTER_POSITION";
      /** The holding that could be used, in the opportunity's required entry asset. */
      enterWith: AmountWithUsd;
      entry: EntryRequirement;
      lifecycle: Lifecycle;
      /** The category's headline metric, unchanged (IMPLIED_APY / YIELD_EXPOSURE_APY / NET_APY). */
      referenceYield: YieldMetric | null;
      caveat: string;
    }
  | { kind: "NONE"; reason: string };

/** Headline metric per category for user context. Category semantics, not protocol logic. */
const REFERENCE_METRIC: Partial<Record<Opportunity["category"], YieldMetricType[]>> = {
  FIXED_YIELD: ["IMPLIED_APY", "FIXED_APY"],
  YIELD: ["YIELD_EXPOSURE_APY", "NET_APY"],
  LP: ["NET_APY", "LP_APR"],
};

const ENTER_CAVEAT: Partial<Record<Opportunity["category"], string>> = {
  FIXED_YIELD:
    "Market-implied rate at the snapshot, realised only if bought at this price and held to maturity; the actual price paid includes fees and slippage. Denominated in the accounting asset, not USD.",
  YIELD: "Yield exposure: the position's value depends on future realised yield and decays toward zero at maturity. Not a fixed or guaranteed return.",
  LP: "LP returns combine several components that change over time; value is exposed to the pool's assets and to price movements.",
};

export interface PortfolioOpportunity {
  opportunity: Opportunity;
  holding: Holding;
  context: PortfolioOpportunityContext;
}

function amount(ref: AmountWithUsd["asset"], raw: bigint, price: UsdPrice | null): AmountWithUsd {
  return {
    asset: ref,
    amount: { raw, decimals: ref.decimals, display: formatFixed(raw, ref.decimals) },
    usd: price ? (() => { const e18 = usdValueE18(raw, ref.decimals, price.raw, price.decimals); return { e18, display: formatFixed(e18, USD_DECIMALS) }; })() : null,
  };
}

export const MAX_BORROW_FORMULA = "floor(floor(collateralRaw × collateralPrice.raw / collateralPrice.scale) × LLTV / 1e18)";
export const MAX_BORROW_CAVEAT =
  "Protocol maximum at the liquidation threshold (LLTV). Borrowing this much makes the position liquidatable on the next adverse price move or interest accrual. Not a recommended or safe amount.";

/**
 * @param row        the user's holding of the opportunity's primary asset (Phase 1 output)
 * @param borrowAssetPrice  USD price of the borrow asset from the Phase 1 Price Service (or null)
 */
export function buildPortfolioOpportunity(o: Opportunity, row: PortfolioAsset, borrowAssetPrice: UsdPrice | null): PortfolioOpportunity {
  const holding: Holding = { assetKey: row.asset.key, rawBalance: row.rawBalance ?? 0n, displayBalance: row.displayBalance, valueUsd: row.valueUsd };
  const heldPrice = row.price?.status === "PRICED" ? row.price.priceUsd : null;
  if (row.rawBalance === null || row.rawBalance <= 0n) return { opportunity: o, holding, context: { kind: "NONE", reason: "no readable positive balance" } };

  if (o.category === "COLLATERAL") {
    const collateralHeld = amount(o.primaryAsset, row.rawBalance, heldPrice);
    const borrowRef = o.borrowAssets[0];
    const lt = o.liquidation;
    const base = { kind: "COLLATERAL" as const, collateralHeld, formula: MAX_BORROW_FORMULA, caveat: MAX_BORROW_CAVEAT };
    if (!borrowRef || !lt || !lt.collateralPrice) {
      return { opportunity: o, holding, context: { ...base, protocolMaximumBorrow: null, protocolMaximumBorrowLiquidityCapped: null, unavailableReason: !lt ? "no liquidation terms" : "protocol collateral price unavailable" } };
    }
    const p = lt.collateralPrice.value;
    const maxRaw = wMulDown(mulDivDown(row.rawBalance, p.raw, p.scale), lt.lltv.value);
    // Only a borrowable liquidity figure can cap a borrow.
    const liquidityRaw = o.liquidityKind === "BORROWABLE" ? (o.availableLiquidity?.value.amount?.raw ?? null) : null;
    const cappedRaw = liquidityRaw === null ? null : maxRaw < liquidityRaw ? maxRaw : liquidityRaw;
    return {
      opportunity: o,
      holding,
      context: {
        ...base,
        protocolMaximumBorrow: amount(borrowRef, maxRaw, borrowAssetPrice),
        protocolMaximumBorrowLiquidityCapped: cappedRaw === null ? null : amount(borrowRef, cappedRaw, borrowAssetPrice),
        unavailableReason: null,
      },
    };
  }
  if (o.category === "FIXED_YIELD" || o.category === "YIELD" || o.category === "LP") {
    if (o.entry.requiredAsset.key !== row.asset.key) {
      return { opportunity: o, holding, context: { kind: "NONE", reason: `entry requires ${o.entry.requiredAsset.symbol}, not the held asset` } };
    }
    const wanted = REFERENCE_METRIC[o.category] ?? [];
    const reference = wanted.map((t) => o.yields.find((y) => y.type === t)).find((y) => !!y) ?? null;
    return {
      opportunity: o,
      holding,
      context: { kind: "ENTER_POSITION", enterWith: amount(o.primaryAsset, row.rawBalance, heldPrice), entry: o.entry, lifecycle: o.lifecycle, referenceYield: reference, caveat: ENTER_CAVEAT[o.category] ?? "" },
    };
  }
  if (o.category === "LEND" || o.category === "VAULT") {
    const earn = o.yields.filter((y) => y.side === "EARN");
    const reference = earn.find((y) => y.type === "SUPPLY_APY") ?? earn.find((y) => y.type === "NET_APY") ?? null;
    return {
      opportunity: o,
      holding,
      context: {
        kind: "SUPPLY",
        suppliable: amount(o.primaryAsset, row.rawBalance, heldPrice),
        referenceYield: reference,
        caveat: "Variable rate at the time of the snapshot; not a projection. Withdrawals depend on available liquidity.",
      },
    };
  }
  return { opportunity: o, holding, context: { kind: "NONE", reason: `no user context defined for ${o.category}` } };
}
