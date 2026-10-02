/**
 * How strongly a value or a registry entry is backed by evidence.
 *
 * Ordered strongest → weakest. Only the first three are "authoritative"; anything else
 * must be visibly disclosed by the frontend and never used silently as fact.
 */
export const VERIFICATION_STATUSES = [
  "VERIFIED_ONCHAIN", // read from the contract itself at a known block
  "VERIFIED_OFFICIAL_API", // served by the protocol's / issuer's own API
  "VERIFIED_OFFICIAL_DOCS", // stated by official docs or an official deployment registry, not re-read live
  "THIRD_PARTY_ONLY", // only an indexer / directory / aggregator says so
  "CONFLICT", // authoritative sources disagree; both sides must be recorded
  "UNVERIFIED", // no adequate evidence
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

const AUTHORITATIVE: ReadonlySet<VerificationStatus> = new Set([
  "VERIFIED_ONCHAIN",
  "VERIFIED_OFFICIAL_API",
  "VERIFIED_OFFICIAL_DOCS",
]);

export function isAuthoritative(status: VerificationStatus): boolean {
  return AUTHORITATIVE.has(status);
}

/** True when the UI must show a warning / badge next to the value. */
export function requiresDisclosure(status: VerificationStatus): boolean {
  return !isAuthoritative(status);
}

function rank(status: VerificationStatus): number {
  return VERIFICATION_STATUSES.indexOf(status);
}

/**
 * The status of something built from several inputs is the weakest input's status:
 * an APY computed from an onchain rate and a third-party price is only THIRD_PARTY_ONLY.
 * An empty list has no evidence at all.
 */
export function weakestStatus(statuses: readonly VerificationStatus[]): VerificationStatus {
  if (statuses.length === 0) return "UNVERIFIED";
  return statuses.reduce((weakest, s) => (rank(s) > rank(weakest) ? s : weakest));
}
