/**
 * Generic, provenance-carrying relationships between tokens. Not Pendle-specific: the same
 * kinds describe vault shares, LP tokens and receipt tokens.
 *
 *   WRAPS                   `from` is a wrapper holding `to` (e.g. SY-NVDA wraps NVDA)
 *   REPRESENTS_CLAIM_ON     `from` is redeemable for `to` under stated conditions (e.g. PT → accounting asset at maturity)
 *   PRINCIPAL_COMPONENT_OF  `from` is the principal part split from `to` (PT of SY)
 *   YIELD_COMPONENT_OF      `from` is the yield part split from `to` (YT of SY)
 *   LP_SHARE_OF             `from` is a share of a pool holding `to` (LP of PT and SY)
 *   DERIVED_FROM            any other verified derivation
 */
import type { AssetRef } from "./opportunity.js";
import type { DataSource } from "./provenance.js";
import type { VerificationStatus } from "./verification.js";

export type AssetRelationshipKind = "WRAPS" | "REPRESENTS_CLAIM_ON" | "PRINCIPAL_COMPONENT_OF" | "YIELD_COMPONENT_OF" | "LP_SHARE_OF" | "DERIVED_FROM";

export interface AssetRelationship {
  kind: AssetRelationshipKind;
  from: AssetRef;
  to: AssetRef;
  /** Conditions of the relationship in plain words, e.g. "1:1 at maturity, in accounting-asset units". */
  terms: string | null;
  source: DataSource;
  verification: VerificationStatus;
}

/** Follow WRAPS / *_COMPONENT_OF edges from `start` to the first canonical asset, if any. */
export function resolveToCanonical(start: AssetRef, edges: readonly AssetRelationship[], maxDepth = 4): { path: AssetRelationship[]; canonical: AssetRef | null } {
  const path: AssetRelationship[] = [];
  let cur = start;
  for (let i = 0; i < maxDepth; i++) {
    if (cur.canonical) return { path, canonical: cur };
    const next = edges.find((e) => e.from.key === cur.key && (e.kind === "WRAPS" || e.kind === "PRINCIPAL_COMPONENT_OF" || e.kind === "YIELD_COMPONENT_OF"));
    if (!next) break;
    path.push(next);
    cur = next.to;
  }
  return { path, canonical: cur.canonical ? cur : null };
}
