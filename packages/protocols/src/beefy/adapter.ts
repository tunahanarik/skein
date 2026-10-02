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
import { CACHE_TTL_MS } from "@skein/core/config/freshness";
import { TtlCache } from "@skein/core/lib/cache";
import type { HttpClient } from "@skein/core/lib/http";
import type { Opportunity, OpportunityCategory } from "@skein/core/model/opportunity";
import type { DataSource } from "@skein/core/model/provenance";
import { warn, type Warning } from "@skein/core/model/warnings";
import type { AdapterCapabilities, AdapterContext, AdapterIssue, AdapterResult, OpportunityAdapter } from "@skein/engine/opportunities/adapter";
import { managedLpOpportunities, same, V3_FACTORY, verifyV3Pools, type ManagedLpInput } from "../shared/managedLp.js";

export const PROTOCOL = { id: "beefy", name: "Beefy" } as const;
export const BEEFY_COW_URL = "https://api.beefy.finance/cow-vaults";
export const BEEFY_APY_URL = "https://api.beefy.finance/apy/breakdown";

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
]);

const ms = (t: number) => Math.round(performance.now() - t);

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

    // ---- onchain identity: wants, balances, strategy → pool (official v3: factory + getPool) ----
    const b = { blockNumber: ctx.blockNumber };
    const step1 = await ctx.reader.multicall(
      vaults.flatMap((v) => (["wants", "balances", "strategy"] as const).map((functionName) => ({ address: v.earnContractAddress as Address, abi: clmAbi, functionName }))),
      b,
    );
    const ok = <T>(i: number): T | null => (step1[i]?.status === "success" ? (step1[i] as { result: T }).result : null);
    const strat = vaults.map((_, i) => ok<Address>(i * 3 + 2));
    const step2 = await ctx.reader.multicall(strat.map((s) => ({ address: (s ?? V3_FACTORY) as Address, abi: clmAbi, functionName: "pool" })), b);
    const pools = step2.map((r, i) => (strat[i] && r?.status === "success" ? (r.result as Address) : null));
    const poolInfo = await verifyV3Pools(ctx, pools);

    const inputs: ManagedLpInput[] = [];
    const fetchedAt = apy?.fetchedAt ?? apiAt;
    vaults.forEach((v, i) => {
      const wants = ok<readonly [Address, Address]>(i * 3);
      const bal = ok<readonly [bigint, bigint]>(i * 3 + 1);
      const info = poolInfo[i];
      const short = `${v.earnContractAddress.slice(0, 10)}…`;
      const api = v.depositTokenAddresses;
      const wantsMatch = !!wants && ((same(wants[0], api[0]!) && same(wants[1], api[1]!)) || (same(wants[0], api[1]!) && same(wants[1], api[0]!)));
      const poolMatch = !!info && !!wants && ((same(info.token0, wants[0]) && same(info.token1, wants[1])) || (same(info.token0, wants[1]) && same(info.token1, wants[0])));
      if (!wantsMatch || !poolMatch || !bal) {
        warnings.push(warn("MARKET_UNVERIFIED_ONCHAIN", `Beefy CLM ${short}: onchain identity check failed (${!wantsMatch ? "wants ≠ API tokens" : !poolMatch ? "pool not an official Uniswap v3 pool of these tokens" : "balances unreadable"}); not published`));
        return;
      }
      const ap = apy?.data.get(v.id) ?? null;
      const src: DataSource = { type: "OFFICIAL_API", provider: "beefy-api", url: BEEFY_APY_URL, chainId: ctx.chainId, method: `apy/breakdown[${v.id.slice(0, 80)}]`, observedAt: fetchedAt };
      const risks = Object.entries(v.risks ?? {}).filter(([, x]) => x).map(([k]) => k);
      const chain = (contract: Address, method: string): DataSource => ({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: ctx.blockNumber, observedAt: ctx.now().toISOString() });
      inputs.push({
        protocol: PROTOCOL,
        manager: "BEEFY_CLM",
        managerLabel: "Beefy CLM",
        vault: v.earnContractAddress as Address,
        pool: pools[i]!,
        feePpm: info!.fee,
        tokens: [wants![0], wants![1]],
        amounts: [bal[0], bal[1]],
        amountsMethod: "balances()",
        rate: ap?.totalApy != null ? { type: "NET_APY", value: ap.totalApy, label: "Beefy CLM APY (Uniswap v3 fees, compounded, after Beefy's performance fee)", compounding: "COMPOUNDED", source: src, fetchedAt } : null,
        apiId: v.id,
        identitySources: [chain(v.earnContractAddress as Address, "wants()"), chain(pools[i]!, "factory()"), chain(V3_FACTORY, "getPool()")],
        protocolWarnings: risks.map((r) => ({ type: r, level: "INFO" })),
        extraWarnings: risks.includes("notAudited") ? [warn("PROTOCOL_WARNING", "Beefy lists this CLM as not audited")] : [],
        entryNote: "Deposits take both {pair} tokens in the pool's current ratio. Concentrated liquidity: the position's token mix changes with price (impermanent loss).",
        mutability: "the CLM strategy rebalances the Uniswap v3 range automatically",
      });
    });
    if (inputs.length < vaults.length) issues.push({ scope: "beefy:identity", message: `${vaults.length - inputs.length} CLMs failed onchain identity checks`, severity: "DEGRADED" });
    const out = await managedLpOpportunities(ctx, inputs);
    return { data: out, status: issues.length ? "PARTIAL" : "COMPLETE", issues, warnings, timingsMs: { total: ms(t0) } };
  }
}
