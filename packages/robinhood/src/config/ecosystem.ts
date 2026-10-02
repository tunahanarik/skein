/**
 * Ecosystem metadata (Phase 5, decisions P4-1, P4-2, P4-3, P4-7). These venues are KNOWN but NOT
 * integrated; they are never turned into opportunities. Evidence: docs/research/dex-ecosystem.md,
 * docs/protocols/uniswap-adapter.md. Nothing here is shown as actionable.
 */
export type EcosystemStatus = "DEFERRED" | "METADATA_ONLY";

export interface EcosystemVenue {
  id: string;
  name: string;
  kind: "AMM" | "ORDERBOOK" | "PROP_AMM" | "AGGREGATOR";
  status: EcosystemStatus;
  decision: "P4-1" | "P4-2" | "P4-3" | "P4-7";
  reason: string;
  source: string;
}

export const ECOSYSTEM_VENUES: readonly EcosystemVenue[] = [
  {
    id: "uniswap-v4",
    name: "Uniswap v4",
    kind: "AMM",
    status: "DEFERRED",
    decision: "P4-1",
    reason: "Hooks run arbitrary code (even inside quote simulations); needs a hook security policy and singleton TVL semantics — a separate phase.",
    source: "https://github.com/Uniswap/contracts/blob/main/deployments/json/4663.json",
  },
  {
    id: "ramses",
    name: "Ramses",
    kind: "AMM",
    status: "DEFERRED",
    decision: "P4-2",
    reason: "Strongest non-Uniswap candidate; no second DEX is integrated in Phase 5.",
    source: "https://www.ramses.xyz/docs/contract-addresses",
  },
  {
    id: "lighter",
    name: "Lighter (Robinhood Chain instance)",
    kind: "ORDERBOOK",
    status: "METADATA_ONLY",
    decision: "P4-3",
    reason: "Offchain matching; no verified onchain market depth. Not an actionable opportunity.",
    source: "https://docs.robinhood.com/chain/lighter-domains/",
  },
  {
    id: "rialto",
    name: "Rialto",
    kind: "PROP_AMM",
    status: "METADATA_ONLY",
    decision: "P4-3",
    reason: "Quotes require a wallet-signed API key; no verified market depth. Not an actionable opportunity.",
    source: "https://docs.rialto.xyz/developers/router-registries.md",
  },
  {
    id: "aggregators",
    name: "Aggregators (KyberSwap, Sushi API, LI.FI, 0x, 1inch)",
    kind: "AGGREGATOR",
    status: "DEFERRED",
    decision: "P4-7",
    reason: "Cross-checking quotes against aggregators is future execution-validation work; not integrated.",
    source: "docs/research/dex-ecosystem.md",
  },
];
