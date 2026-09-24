/**
 * Beefy CLM (Cowcentrated Liquidity Manager) adapter → LP opportunities.
 *
 * Source of candidates: the official Beefy API (`/cow-vaults`, chain "robinhood"); APY from
 * `/apy/breakdown` (fee APR compounded, after Beefy's performance fee). NOTHING is published on the
 * API's word alone. Each CLM must pass, onchain at the pinned block:
 *   CLM.wants() == API deposit tokens (order-insensitive)
 *   CLM.strategy().pool() is a Uniswap v3 pool whose factory() is the official v3 factory and
 *   factory.getPool(token0, token1, fee) returns that same pool
 * TVL is onchain: CLM.balances() valued with the Phase 1 Price Service (both tokens must be priced).
 * One opportunity per canonical token of the pair (the user can hold either); entry requires both
 * tokens (the Beefy app can zap from one token — noted, not modelled as a verified route).
 */
import { parseAbi, type Address } from "viem";
import { z } from "zod";
import { CACHE_TTL_MS, classifyFreshness } from "../../config/freshness.js";
import { TtlCache } from "../../lib/cache.js";
import { fixed18FromNumber } from "../../lib/fixed.js";
import type { HttpClient } from "../../lib/http.js";
import { sanitizeSymbol } from "../../lib/sanitize.js";
import { formatFixed, usdValueE18, USD_DECIMALS } from "../../lib/units.js";
import { opportunityId, type AmountWithUsd, type AssetRef, type Measured, type Opportunity, type OpportunityCategory, type YieldMetric } from "../../model/opportunity.js";
import type { DataSource } from "../../model/provenance.js";
import { weakestStatus } from "../../model/verification.js";
import { warn, type Warning } from "../../model/warnings.js";
import type { AdapterCapabilities, AdapterContext, AdapterIssue, AdapterResult, OpportunityAdapter } from "../../opportunities/adapter.js";
import { priceCanonicalAssets } from "../../opportunities/assetPricing.js";
import { openEndedLifecycle } from "../../opportunities/lifecycle.js";
import { UNISWAP_READ_CONTRACTS } from "../uniswap/constants.js";

export const PROTOCOL = { id: "beefy", name: "Beefy" } as const;
export const BEEFY_COW_URL = "https://api.beefy.finance/cow-vaults";
export const BEEFY_APY_URL = "https://api.beefy.finance/apy/breakdown";
const V3_FACTORY = UNISWAP_READ_CONTRACTS.v3Factory as Address;

const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const cowVaultSchema = z
  .object({
    id: z.string().max(200),
    name: z.string().max(200).optional(),
    chain: z.string(),
    status: z.string(),
    tokenProviderId: z.string().optional(),
    earnContractAddress: addr,
    depositTokenAddresses: z.array(addr).length(2),
    strategy: addr.optional(),
    feeTier: z.string().optional(),
    risks: z.record(z.string(), z.boolean()).optional(),
  })
  .passthrough();
export type CowVault = z.infer<typeof cowVaultSchema>;
const cowListSchema = z.array(z.unknown()).transform((xs) => xs.flatMap((x) => {
  const r = cowVaultSchema.safeParse(x);
  return r.success && r.data.chain === "robinhood" ? [r.data] : [];
}));
const apySchema = z.record(z.string(), z.unknown()).transform((m) => {
  const out = new Map<string, { totalApy: number | null; clmApr: number | null; fee: number | null }>();
  for (const [k, v] of Object.entries(m)) {
    if (!k.includes("robinhood") || typeof v !== "object" || v === null) continue;
    const o = v as Record<string, unknown>;
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    out.set(k, { totalApy: n(o.totalApy), clmApr: n(o.clmApr), fee: n(o.beefyPerformanceFee) });
  }
  return out;
});

export interface BeefyApi {
  cowVaults(): Promise<{ data: CowVault[]; fetchedAt: string }>;
  apy(): Promise<{ data: Map<string, { totalApy: number | null; clmApr: number | null; fee: number | null }>; fetchedAt: string }>;
}

export class HttpBeefyApi implements BeefyApi {
  private readonly cache = new TtlCache<unknown>();
  constructor(private readonly http: HttpClient) {}
  cowVaults() {
    return this.cache.getOrLoad("cow", CACHE_TTL_MS.PROTOCOL_MARKET_STATE, async () => {
      const r = await this.http.getJson(BEEFY_COW_URL, cowListSchema, { maxBytes: 4_000_000 });
      return { data: r.data, fetchedAt: r.fetchedAt };
    }) as Promise<{ data: CowVault[]; fetchedAt: string }>;
  }
  apy() {
    return this.cache.getOrLoad("apy", CACHE_TTL_MS.PROTOCOL_MARKET_STATE, async () => {
      const r = await this.http.getJson(BEEFY_APY_URL, apySchema, { maxBytes: 4_000_000 });
      return { data: r.data, fetchedAt: r.fetchedAt };
    }) as ReturnType<BeefyApi["apy"]>;
  }
}

export const clmAbi = parseAbi([
  "function wants() view returns (address, address)",
  "function balances() view returns (uint256, uint256)",
  "function strategy() view returns (address)",
  "function pool() view returns (address)",
  "function factory() view returns (address)",
  "function fee() view returns (uint24)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getPool(address, address, uint24) view returns (address)",
]);

const ms = (t: number) => Math.round(performance.now() - t);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class BeefyAdapter implements OpportunityAdapter {
  readonly protocol = { ...PROTOCOL };
  readonly categories: readonly OpportunityCategory[] = ["LP"];
  readonly capabilities: AdapterCapabilities = { discovery: true, assetFiltering: false, userPositions: false, singleOpportunity: false, execution: false };
  private readonly api: BeefyApi;

  constructor(http: HttpClient, opts: { api?: BeefyApi } = {}) {
    this.api = opts.api ?? new HttpBeefyApi(http);
  }

  supportsCategory(c: OpportunityCategory): boolean {
    return this.categories.includes(c);
  }

  async getOpportunities(ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>> {
    const t0 = performance.now();
    const issues: AdapterIssue[] = [];
    const warnings: Warning[] = [];
    let vaults: CowVault[];
    let apiAt: string;
    try {
      const r = await this.api.cowVaults();
      vaults = r.data.filter((v) => v.status === "active" && (v.tokenProviderId ?? "uniswap") === "uniswap");
      apiAt = r.fetchedAt;
    } catch (e) {
      return { data: [], status: "UNKNOWN", issues: [{ scope: "beefy-api:cow-vaults", message: (e as Error).message, severity: "FATAL" }], warnings, timingsMs: { total: ms(t0) } };
    }
    const apy = await this.api.apy().catch((e) => {
      issues.push({ scope: "beefy-api:apy", message: (e as Error).message, severity: "DEGRADED" });
      return null;
    });
    if (!vaults.length) return { data: [], status: "COMPLETE", issues, warnings, timingsMs: { total: ms(t0) } };

    // ---- onchain identity: wants, balances, strategy → pool → factory/fee/tokens ----
    const b = { blockNumber: ctx.blockNumber };
    const step1 = await ctx.reader.multicall(
      vaults.flatMap((v) => [
        { address: v.earnContractAddress as Address, abi: clmAbi, functionName: "wants" },
        { address: v.earnContractAddress as Address, abi: clmAbi, functionName: "balances" },
        { address: v.earnContractAddress as Address, abi: clmAbi, functionName: "strategy" },
      ]),
      b,
    );
    const ok = <T>(i: number): T | null => (step1[i]?.status === "success" ? (step1[i] as { result: T }).result : null);
    const strat = vaults.map((_, i) => ok<Address>(i * 3 + 2));
    const step2 = await ctx.reader.multicall(strat.map((s) => ({ address: (s ?? V3_FACTORY) as Address, abi: clmAbi, functionName: "pool" })), b);
    const pools = step2.map((r, i) => (strat[i] && r?.status === "success" ? (r.result as Address) : null));
    const step3 = await ctx.reader.multicall(
      pools.flatMap((p) => [
        { address: (p ?? V3_FACTORY) as Address, abi: clmAbi, functionName: "factory" },
        { address: (p ?? V3_FACTORY) as Address, abi: clmAbi, functionName: "fee" },
        { address: (p ?? V3_FACTORY) as Address, abi: clmAbi, functionName: "token0" },
        { address: (p ?? V3_FACTORY) as Address, abi: clmAbi, functionName: "token1" },
      ]),
      b,
    );
    const s3 = <T>(i: number, k: number): T | null => (pools[i] && step3[i * 4 + k]?.status === "success" ? (step3[i * 4 + k] as { result: T }).result : null);
    const step4 = await ctx.reader.multicall(
      pools.map((p, i) => {
        const t0a = s3<Address>(i, 2);
        const t1a = s3<Address>(i, 3);
        const fee = s3<number>(i, 1);
        return { address: V3_FACTORY, abi: clmAbi, functionName: "getPool", args: [t0a ?? V3_FACTORY, t1a ?? V3_FACTORY, fee ?? 0] };
      }),
      b,
    );

    const verified: { v: CowVault; tokens: [Address, Address]; balances: [bigint, bigint]; pool: Address; fee: number }[] = [];
    vaults.forEach((v, i) => {
      const wants = ok<readonly [Address, Address]>(i * 3);
      const bal = ok<readonly [bigint, bigint]>(i * 3 + 1);
      const pool = pools[i];
      const factory = s3<Address>(i, 0);
      const fee = s3<number>(i, 1);
      const p0 = s3<Address>(i, 2);
      const p1 = s3<Address>(i, 3);
      const canonicalPool = step4[i]?.status === "success" ? (step4[i]!.result as Address) : null;
      const short = `${v.earnContractAddress.slice(0, 10)}…`;
      const apiTokens = v.depositTokenAddresses;
      const wantsMatch = !!wants && ((same(wants[0], apiTokens[0]!) && same(wants[1], apiTokens[1]!)) || (same(wants[0], apiTokens[1]!) && same(wants[1], apiTokens[0]!)));
      const poolOk = !!pool && !!factory && same(factory, V3_FACTORY) && !!canonicalPool && same(canonicalPool, pool) && !!p0 && !!p1 && !!wants && ((same(p0, wants[0]) && same(p1, wants[1])) || (same(p0, wants[1]) && same(p1, wants[0])));
      if (!wantsMatch || !poolOk || !bal || fee === null) {
        warnings.push(warn("MARKET_UNVERIFIED_ONCHAIN", `Beefy CLM ${short}: onchain identity check failed (${!wantsMatch ? "wants ≠ API tokens" : !poolOk ? "pool not an official Uniswap v3 pool of these tokens" : "balances unreadable"}); not published`));
        return;
      }
      verified.push({ v, tokens: [wants![0], wants![1]], balances: [bal[0], bal[1]], pool: pool!, fee });
    });
    if (verified.length < vaults.length) issues.push({ scope: "beefy:identity", message: `${vaults.length - verified.length} CLMs failed onchain identity checks`, severity: "DEGRADED" });

    // ---- assets and prices ----
    const refOf = (a: Address): AssetRef => {
      const r = ctx.registry.get(ctx.chainId, a);
      return r?.canonical
        ? { key: r.key, chainId: ctx.chainId, address: r.address!, symbol: r.symbol, decimals: r.decimals, canonical: true, registryType: r.type }
        : { key: `${ctx.chainId}:${a.toLowerCase()}`, chainId: ctx.chainId, address: a, symbol: "unknown", decimals: 18, canonical: false, registryType: null };
    };
    const keys = new Set(verified.flatMap((x) => x.tokens.map((a) => refOf(a).key)));
    const { priceOf } = await priceCanonicalAssets(ctx, keys);
    const observedAt = new Date(Number(ctx.blockTimestamp) * 1000).toISOString();
    const nowS = Math.floor(ctx.now().getTime() / 1000);
    const fresh = classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), nowS);
    const apiFresh = classifyFreshness("PROTOCOL_API_MARKET_STATE", Math.floor(Date.parse(apy?.fetchedAt ?? apiAt) / 1000), nowS);
    const chainSrc = (contract: Address, method: string): DataSource => ({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: ctx.blockNumber, observedAt: ctx.now().toISOString() });
    const apiSrc = (id: string): DataSource => ({ type: "OFFICIAL_API", provider: "beefy-api", url: BEEFY_APY_URL, chainId: ctx.chainId, method: `apy/breakdown[${id.slice(0, 80)}]`, observedAt: apy?.fetchedAt ?? apiAt });

    const out: Opportunity[] = [];
    for (const x of verified) {
      const [a0, a1] = x.tokens.map(refOf) as [AssetRef, AssetRef];
      const p0 = a0.canonical ? priceOf(a0.key).price : null;
      const p1 = a1.canonical ? priceOf(a1.key).price : null;
      const usd0 = p0 ? usdValueE18(x.balances[0], a0.decimals, p0.raw, p0.decimals) : null;
      const usd1 = p1 ? usdValueE18(x.balances[1], a1.decimals, p1.raw, p1.decimals) : null;
      const tvlUsd = usd0 !== null && usd1 !== null ? usd0 + usd1 : null;
      const ap = apy?.data.get(x.v.id) ?? null;
      const yields: YieldMetric[] =
        ap?.totalApy != null
          ? [{ type: "NET_APY", side: "EARN", basis: "VARIABLE", compounding: "COMPOUNDED", window: "protocol-defined", denominatedIn: null, label: "Beefy CLM APY (Uniswap v3 fees, compounded, after Beefy's performance fee)", value: fixed18FromNumber(ap.totalApy), origin: "SUPPLIED", source: apiSrc(x.v.id), observedAt: apy!.fetchedAt, freshness: apiFresh, verification: "VERIFIED_OFFICIAL_API" }]
          : [];
      const tvl: Measured<AmountWithUsd> | null =
        tvlUsd !== null
          ? { value: { asset: a0, amount: null, usd: { e18: tvlUsd, display: formatFixed(tvlUsd, USD_DECIMALS) } }, origin: "COMPUTED", formula: "balances() × Phase 1 prices", source: chainSrc(x.v.earnContractAddress as Address, "balances()"), observedAt, freshness: fresh, verification: "VERIFIED_ONCHAIN" } as Measured<AmountWithUsd>
          : null;
      const risks = Object.entries(x.v.risks ?? {}).filter(([, v]) => v).map(([k]) => k);
      const pairLabel = `${sanitizeSymbol(a0.symbol)}/${sanitizeSymbol(a1.symbol)}`;
      for (const primary of [a0, a1]) {
        if (!primary.canonical) continue;
        const other = primary === a0 ? a1 : a0;
        const w: Warning[] = [];
        if (!tvl) w.push(warn("UNPRICED_METRIC", `Beefy CLM ${pairLabel}: a token is unpriced; TVL unavailable`));
        if (risks.includes("notAudited")) w.push(warn("PROTOCOL_WARNING", `Beefy lists this CLM as not audited`));
        out.push({
          id: opportunityId(ctx.chainId, PROTOCOL.id, "LP", "beefy-clm", `${x.v.earnContractAddress}:${primary.address}`),
          chainId: ctx.chainId,
          protocol: { ...PROTOCOL },
          category: "LP",
          title: `Provide ${pairLabel} liquidity through a Beefy CLM (Uniswap v3 ${(x.fee / 10_000).toFixed(2)}% pool)`,
          venue: { kind: "BEEFY_CLM", id: (x.v.earnContractAddress as string).toLowerCase(), address: x.v.earnContractAddress as Address },
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
            steps: [{ action: "ADD_LIQUIDITY", from: primary, to: null, venue: `Beefy CLM ${x.v.earnContractAddress}`, verified: true, source: chainSrc(x.v.earnContractAddress as Address, "wants()") }],
            singleTransactionAvailable: { known: false, reason: "a CLM deposit takes both tokens; the Beefy app's single-token zap is not verified here" },
            note: `Deposits take both ${pairLabel} tokens in the pool's current ratio. Concentrated liquidity: the position's token mix changes with price (impermanent loss).`,
          },
          relationships: [],
          eligibility: null,
          contracts: [
            { role: "vault", address: x.v.earnContractAddress as Address },
            { role: "pool", address: x.pool },
          ],
          risk: {
            oracle: null,
            lltv: { known: false, reason: "not a lending market" },
            utilization: { known: false, reason: "liquidity manager" },
            availableLiquidityUsd: tvl?.value.usd ? { known: true, value: tvl.value.usd, source: tvl.source } : { known: false, reason: "unpriced" },
            marketSizeUsd: tvl?.value.usd ? { known: true, value: tvl.value.usd, source: tvl.source } : { known: false, reason: "unpriced" },
            rewardDependence: { known: false, reason: "fee APR only; rewards not broken out" },
            parameterMutability: { known: true, value: "the CLM strategy rebalances the Uniswap v3 range automatically", source: apiSrc(x.v.id) },
            protocolListed: { known: true, value: true, source: { ...apiSrc(x.v.id), url: BEEFY_COW_URL } },
            protocolWarnings: risks.map((r) => ({ type: r, level: "INFO" })),
            allAssetsCanonical: a0.canonical && a1.canonical,
          },
          details: { kind: "BEEFY_CLM", clm: x.v.earnContractAddress as Address, pool: x.pool, feePpm: x.fee, tokens: [a0, a1], balances: [x.balances[0], x.balances[1]], apiId: x.v.id.slice(0, 200) },
          provenance: [chainSrc(x.v.earnContractAddress as Address, "wants()"), chainSrc(x.pool, "factory()"), chainSrc(V3_FACTORY, "getPool()"), apiSrc(x.v.id)],
          conflicts: [],
          warnings: w,
          freshness: yields.length ? apiFresh : fresh,
          verificationStatus: weakestStatus([a0.canonical && a1.canonical ? "VERIFIED_ONCHAIN" : "UNVERIFIED", tvl ? "VERIFIED_ONCHAIN" : "UNVERIFIED", ...yields.map((y) => y.verification)]),
          observedAt,
          generatedAt: ctx.now().toISOString(),
        });
      }
    }
    return { data: out, status: issues.length ? "PARTIAL" : "COMPLETE", issues, warnings, timingsMs: { total: ms(t0) } };
  }
}
