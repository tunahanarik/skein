/**
 * Raw opportunity category → product grouping. Protocol-internal names are not exposed as the
 * top level; the raw category stays in `ProductCard.rawCategory`.
 *
 *   TRADE      TRADE
 *   EARN       LEND · VAULT · FIXED_YIELD · YIELD
 *   BORROW     COLLATERAL   (borrowing needs collateral, so it is the collateral holder's view)
 *   LIQUIDITY  LP
 */
import type { OpportunityCategory } from "../model/opportunity.js";
import type { ProductCategory, ProductSubcategory } from "./types.js";

export const PRODUCT_CATEGORY_ORDER: readonly ProductCategory[] = ["TRADE", "EARN", "BORROW", "LIQUIDITY"];

export const SUBCATEGORY_ORDER: Readonly<Record<ProductCategory, readonly ProductSubcategory[]>> = {
  TRADE: ["TRADE"],
  EARN: ["LEND", "VAULT", "FIXED_YIELD", "YIELD"],
  BORROW: ["COLLATERAL"],
  LIQUIDITY: ["LP"],
};

export function productCategoryOf(raw: OpportunityCategory): { category: ProductCategory; subcategory: ProductSubcategory } | null {
  switch (raw) {
    case "TRADE":
      return { category: "TRADE", subcategory: "TRADE" };
    case "LEND":
      return { category: "EARN", subcategory: "LEND" };
    case "VAULT":
      return { category: "EARN", subcategory: "VAULT" };
    case "FIXED_YIELD":
      return { category: "EARN", subcategory: "FIXED_YIELD" };
    case "YIELD":
      return { category: "EARN", subcategory: "YIELD" };
    case "COLLATERAL":
      return { category: "BORROW", subcategory: "COLLATERAL" };
    case "LP":
      return { category: "LIQUIDITY", subcategory: "LP" };
    case "BORROW":
      return { category: "BORROW", subcategory: "COLLATERAL" };
  }
}
