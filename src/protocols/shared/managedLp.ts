/**
 * Shared pieces for managed-liquidity adapters (Beefy CLM, Steer) over Uniswap v3:
 *   verifyV3Pools   — pool.factory() is the official v3 factory AND factory.getPool(t0, t1, fee)
 *                     returns the same pool (so the pool, its tokens and fee are genuine)
 *   managedLpOpportunities — one LP opportunity per canonical token of the pair, TVL from the
 *                     manager's onchain token amounts valued with the Phase 1 Price Service
 */
import { parseAbi, type Address } from "viem";
import { classifyFreshness } from "../../config/freshness.js";
import { fixed18FromNumber } from "../../lib/fixed.js";
import { sanitizeSymbol } from "../../lib/sanitize.js";
import { formatFixed, usdValueE18, USD_DECIMALS } from "../../lib/units.js";
import { opportunityId, type AmountWithUsd, type AssetRef, type Measured, type Opportunity, type YieldMetric } from "../../model/opportunity.js";
import type { DataSource } from "../../model/provenance.js";
import { weakestStatus } from "../../model/verification.js";
import { warn, type Warning } from "../../model/warnings.js";
import type { AdapterContext } from "../../opportunities/adapter.js";
import { priceCanonicalAssets } from "../../opportunities/assetPricing.js";
import { openEndedLifecycle } from "../../opportunities/lifecycle.js";
import { UNISWAP_READ_CONTRACTS } from "../uniswap/constants.js";

export const V3_FACTORY = UNISWAP_READ_CONTRACTS.v3Factory as Address;
export const poolAbi = parseAbi([
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getPool(address, address, uint24) view returns (address)",
]);

export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** For each pool: its tokens and fee if it is a genuine official Uniswap v3 pool, else null. */
export async function verifyV3Pools(ctx: AdapterContext, pools: readonly (Address | null)[]): Promise<({ token0: Address; token1: Address; fee: number } | null)[]> {
  const b = { blockNumber: ctx.blockNumber };
  const r = await ctx.reader.multicall(
    pools.flatMap((p) => (["factory", "fee", "token0", "token1"] as const).map((functionName) => ({ address: (p ?? V3_FACTORY) as Address, abi: poolAbi, functionName }))),
    b,
  );
  const v = <T>(i: number, k: number): T | null => (pools[i] && r[i * 4 + k]?.status === "success" ? (r[i * 4 + k] as { result: T }).result : null);
  const g = await ctx.reader.multicall(pools.map((_, i) => ({ address: V3_FACTORY, abi: poolAbi, functionName: "getPool", args: [v<Address>(i, 2) ?? V3_FACTORY, v<Address>(i, 3) ?? V3_FACTORY, v<number>(i, 1) ?? 0] })), b);
  return pools.map((p, i) => {
    const factory = v<Address>(i, 0);
    const fee = v<number>(i, 1);
    const t0 = v<Address>(i, 2);
    const t1 = v<Address>(i, 3);
    const back = g[i]?.status === "success" ? (g[i]!.result as Address) : null;
    return p && factory && same(factory, V3_FACTORY) && fee !== null && t0 && t1 && back && same(back, p) ? { token0: t0, token1: t1, fee } : null;
  });
}

export interface ManagedLpInput {
  protocol: { id: string; name: string };
  manager: "BEEFY_CLM" | "STEER";
  managerLabel: string; // "Beefy CLM", "Steer vault"
  vault: Address;
  pool: Address;
  feePpm: number;
  tokens: [Address, Address];
  amounts: [bigint, bigint];
  amountsMethod: string; // "balances()", "getTotalAmounts()"
  rate: { type: "NET_APY" | "LP_APR"; value: number; label: string; compounding: YieldMetric["compounding"]; source: DataSource; fetchedAt: string } | null;
  apiId: string;
  identitySources: DataSource[];
  protocolWarnings: { type: string; level: string }[];
  extraWarnings: Warning[];
  entryNote: string;
  mutability: string;
}

/** One LP opportunity per canonical token of a verified managed-liquidity vault. */
export async function managedLpOpportunities(ctx: AdapterContext, inputs: readonly ManagedLpInput[]): Promise<Opportunity[]> {
  const refOf = (a: Address): AssetRef => {
    const r = ctx.registry.get(ctx.chainId, a);
    return r?.canonical
      ? { key: r.key, chainId: ctx.chainId, address: r.address!, symbol: r.symbol, decimals: r.decimals, canonical: true, registryType: r.type }
      : { key: `${ctx.chainId}:${a.toLowerCase()}`, chainId: ctx.chainId, address: a, symbol: "unknown", decimals: 18, canonical: false, registryType: null };
  };
  const { priceOf } = await priceCanonicalAssets(ctx, new Set(inputs.flatMap((x) => x.tokens.map((a) => refOf(a).key))));
  const observedAt = new Date(Number(ctx.blockTimestamp) * 1000).toISOString();
  const nowS = Math.floor(ctx.now().getTime() / 1000);
  const fresh = classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), nowS);
  const chainSrc = (contract: Address, method: string): DataSource => ({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: ctx.blockNumber, observedAt: ctx.now().toISOString() });

  const out: Opportunity[] = [];
  for (const x of inputs) {
    const [a0, a1] = x.tokens.map(refOf) as [AssetRef, AssetRef];
    const p0 = a0.canonical ? priceOf(a0.key).price : null;
    const p1 = a1.canonical ? priceOf(a1.key).price : null;
    const usd0 = p0 ? usdValueE18(x.amounts[0], a0.decimals, p0.raw, p0.decimals) : null;
    const usd1 = p1 ? usdValueE18(x.amounts[1], a1.decimals, p1.raw, p1.decimals) : null;
    const tvlUsd = usd0 !== null && usd1 !== null ? usd0 + usd1 : null;
    const rateFresh = x.rate ? classifyFreshness("PROTOCOL_API_MARKET_STATE", Math.floor(Date.parse(x.rate.fetchedAt) / 1000), nowS) : fresh;
    const yields: YieldMetric[] = x.rate
      ? [{ type: x.rate.type, side: "EARN", basis: "VARIABLE", compounding: x.rate.compounding, window: "protocol-defined", denominatedIn: null, label: x.rate.label, value: fixed18FromNumber(x.rate.value), origin: "SUPPLIED", source: x.rate.source, observedAt: x.rate.fetchedAt, freshness: rateFresh, verification: "VERIFIED_OFFICIAL_API" }]
      : [];
    const tvlSrc = chainSrc(x.vault, x.amountsMethod);
    const tvl: Measured<AmountWithUsd> | null =
      tvlUsd !== null ? ({ value: { asset: a0, amount: null, usd: { e18: tvlUsd, display: formatFixed(tvlUsd, USD_DECIMALS) } }, origin: "COMPUTED", formula: `${x.amountsMethod} × Phase 1 prices`, source: tvlSrc, observedAt, freshness: fresh, verification: "VERIFIED_ONCHAIN" } as Measured<AmountWithUsd>) : null;
    const pair = `${sanitizeSymbol(a0.symbol)}/${sanitizeSymbol(a1.symbol)}`;
    for (const primary of [a0, a1]) {
      if (!primary.canonical) continue;
      const other = primary === a0 ? a1 : a0;
      const w: Warning[] = [...x.extraWarnings];
      if (!tvl) w.push(warn("UNPRICED_METRIC", `${x.managerLabel} ${pair}: a token is unpriced; TVL unavailable`));
      out.push({
        id: opportunityId(ctx.chainId, x.protocol.id, "LP", x.manager.toLowerCase(), `${x.vault}:${primary.address}`),
        chainId: ctx.chainId,
        protocol: { ...x.protocol },
        category: "LP",
        title: `Provide ${pair} liquidity through a ${x.managerLabel} (Uniswap v3 ${(x.feePpm / 10_000).toFixed(2)}% pool)`,
        venue: { kind: x.manager, id: x.vault.toLowerCase(), address: x.vault },
        primaryAsset: primary,
        inputAssets: [primary, other],
        outputAssets: [],
        collateralAssets: [],
        borrowAssets: [],
        yields,
        tvl,
        availableLiquidity: tvl,
        liquidityKind: "POOL_LIQUIDITY",
        utilization: null,
        liquidation: null,
        term: { maturity: null, lockSeconds: null, withdrawal: "INSTANT_SUBJECT_TO_LIQUIDITY" },
        lifecycle: openEndedLifecycle({ number: ctx.blockNumber, timestamp: ctx.blockTimestamp }),
        entry: {
          kind: "MULTI_STEP",
          requiredAsset: primary,
          steps: [{ action: "ADD_LIQUIDITY", from: primary, to: null, venue: `${x.managerLabel} ${x.vault}`, verified: true, source: x.identitySources[0] ?? tvlSrc }],
          singleTransactionAvailable: { known: false, reason: "a deposit takes both tokens; any single-token zap in the protocol app is not verified here" },
          note: x.entryNote.replace("{pair}", pair),
        },
        relationships: [],
        eligibility: null,
        contracts: [
          { role: "vault", address: x.vault },
          { role: "pool", address: x.pool },
        ],
        risk: {
          oracle: null,
          lltv: { known: false, reason: "not a lending market" },
          utilization: { known: false, reason: "liquidity manager" },
          availableLiquidityUsd: tvl?.value.usd ? { known: true, value: tvl.value.usd, source: tvl.source } : { known: false, reason: "unpriced" },
          marketSizeUsd: tvl?.value.usd ? { known: true, value: tvl.value.usd, source: tvl.source } : { known: false, reason: "unpriced" },
          rewardDependence: { known: false, reason: "fee rate only; rewards not broken out" },
          parameterMutability: { known: true, value: x.mutability, source: x.identitySources[0] ?? tvlSrc },
          protocolListed: { known: true, value: true, source: x.rate?.source ?? tvlSrc },
          protocolWarnings: x.protocolWarnings,
          allAssetsCanonical: a0.canonical && a1.canonical,
        },
        details: { kind: "MANAGED_LP", manager: x.manager, vault: x.vault, pool: x.pool, feePpm: x.feePpm, tokens: [a0, a1], amounts: [x.amounts[0], x.amounts[1]], apiId: x.apiId.slice(0, 200) },
        provenance: [...x.identitySources, tvlSrc, ...(x.rate ? [x.rate.source] : [])],
        conflicts: [],
        warnings: w,
        freshness: yields.length ? rateFresh : fresh,
        verificationStatus: weakestStatus([a0.canonical && a1.canonical ? "VERIFIED_ONCHAIN" : "UNVERIFIED", tvl ? "VERIFIED_ONCHAIN" : "UNVERIFIED", ...yields.map((y) => y.verification)]),
        observedAt,
        generatedAt: ctx.now().toISOString(),
      });
    }
  }
  return out;
}
