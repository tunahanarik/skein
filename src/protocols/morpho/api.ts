/**
 * Morpho official API client (https://api.morpho.org/graphql). Read-only GraphQL.
 *
 * Verified 2026-09-24: `chains` includes {id: 4663, network: "Robinhood Chain"}.
 * BigInt scalars arrive as JSON numbers when ≤ 2^53−1 and as strings above it (observed), so
 * the schema accepts both but only SAFE integers as numbers. Items are validated one by one:
 * a malformed market is dropped and reported, the rest of the response survives.
 */
import { z } from "zod";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import type { HttpClient } from "../../lib/http.js";

export const MORPHO_API_URL = "https://api.morpho.org/graphql";

const addr = z.string().refine((s) => isAddress(s, { strict: false }), "invalid address").transform((s) => getAddress(s) as Address);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((s) => s.toLowerCase() as Hex);
export const bigintScalar = z
  .union([z.string().regex(/^-?[0-9]+$/), z.number().refine((n) => Number.isSafeInteger(n), "unsafe integer (precision lost)")])
  .transform((v) => BigInt(v));
const float = z.number().finite().nullable().optional().transform((v) => v ?? null);
const big = bigintScalar.nullable().optional().transform((v) => v ?? null);

const apiAsset = z.object({ address: addr, symbol: z.string(), decimals: z.number().int().min(0).max(36) });

export const apiMarketSchema = z.object({
  marketId: hex32,
  listed: z.boolean().nullable().optional().transform((v) => v ?? null),
  lltv: bigintScalar,
  irmAddress: addr,
  loanAsset: apiAsset,
  collateralAsset: apiAsset.nullable(),
  oracle: z.object({ address: addr, type: z.string().nullable().optional() }).nullable(),
  warnings: z.array(z.object({ type: z.string(), level: z.string() })).nullable().optional().transform((v) => v ?? []),
  state: z
    .object({
      blockNumber: big,
      timestamp: big,
      supplyAssets: big,
      borrowAssets: big,
      collateralAssets: big,
      liquidityAssets: big,
      supplyApy: float,
      borrowApy: float,
      netSupplyApy: float,
      netBorrowApy: float,
      utilization: float,
      fee: float,
      rewards: z
        .array(z.object({ asset: z.object({ address: addr, symbol: z.string() }), supplyApr: float, borrowApr: float }))
        .nullable()
        .optional()
        .transform((v) => v ?? []),
    })
    .nullable(),
});
export type ApiMarket = z.infer<typeof apiMarketSchema>;

export const apiVaultSchema = z.object({
  address: addr,
  name: z.string(),
  listed: z.boolean().nullable().optional().transform((v) => v ?? null),
  asset: apiAsset,
  curator: z.object({ address: addr }).nullable().optional().transform((v) => v ?? null),
  totalAssets: big,
  liquidity: big,
  apy: float,
  netApy: float,
  netApyExcludingRewards: float,
  performanceFee: float,
  managementFee: float,
  warnings: z.array(z.object({ type: z.string(), level: z.string() })).nullable().optional().transform((v) => v ?? []),
});
export type ApiVault = z.infer<typeof apiVaultSchema>;

const envelope = z.object({
  data: z.record(z.string(), z.unknown()).nullable().optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

const MARKETS_QUERY = `query($skip:Int!,$chain:Int!){ markets(first:200, skip:$skip, where:{chainId_in:[$chain]}) {
  pageInfo { countTotal count }
  items { marketId listed lltv irmAddress
    loanAsset { address symbol decimals } collateralAsset { address symbol decimals }
    oracle { address type } warnings { type level }
    state { blockNumber timestamp supplyAssets borrowAssets collateralAssets liquidityAssets
      supplyApy borrowApy netSupplyApy netBorrowApy utilization fee
      rewards { asset { address symbol } supplyApr borrowApr } } } } }`;

const VAULTS_QUERY = `query($skip:Int!,$chain:Int!){ vaultV2s(first:100, skip:$skip, where:{chainId_in:[$chain]}) {
  pageInfo { countTotal count }
  items { address name listed asset { address symbol decimals } curator { address }
    totalAssets liquidity apy netApy netApyExcludingRewards performanceFee managementFee
    warnings { type level } } } }`;

export interface ParsedPage<T> {
  items: T[];
  rejected: { index: number; error: string }[];
  countTotal: number | null;
  fetchedAt: string;
}

export class MorphoApiError extends Error {
  override readonly name = "MorphoApiError";
}

export interface MorphoApi {
  markets(chainId: number): Promise<ParsedPage<ApiMarket>>;
  vaults(chainId: number): Promise<ParsedPage<ApiVault>>;
}

export class MorphoApiClient implements MorphoApi {
  constructor(
    private readonly http: HttpClient,
    private readonly url: string = MORPHO_API_URL,
  ) {}

  private async post(query: string, variables: Record<string, unknown>): Promise<{ data: Record<string, unknown>; fetchedAt: string }> {
    const res = await this.http.getJson(this.url, envelope, {
      maxBytes: 5_000_000,
      timeoutMs: 20_000,
      init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) },
    });
    if (res.data.errors?.length) throw new MorphoApiError(`GraphQL: ${res.data.errors.map((e) => e.message).join("; ").slice(0, 300)}`);
    if (!res.data.data) throw new MorphoApiError("GraphQL response has no data");
    return { data: res.data.data, fetchedAt: res.fetchedAt };
  }

  private async paged<T>(query: string, field: string, pageSize: number, chainId: number, schema: z.ZodType<T>): Promise<ParsedPage<T>> {
    const items: T[] = [];
    const rejected: { index: number; error: string }[] = [];
    let countTotal: number | null = null;
    let fetchedAt = "";
    for (let skip = 0; skip < 10_000; skip += pageSize) {
      const r = await this.post(query, { skip, chain: chainId });
      fetchedAt ||= r.fetchedAt;
      const page = z.object({ pageInfo: z.object({ countTotal: z.number().int() }), items: z.array(z.unknown()) }).safeParse(r.data[field]);
      if (!page.success) throw new MorphoApiError(`unexpected ${field} shape: ${page.error.message.slice(0, 200)}`);
      countTotal = page.data.pageInfo.countTotal;
      page.data.items.forEach((raw, i) => {
        const p = schema.safeParse(raw);
        if (p.success) items.push(p.data);
        else rejected.push({ index: skip + i, error: p.error.message.slice(0, 200) });
      });
      if (page.data.items.length < pageSize || skip + pageSize >= countTotal) break;
    }
    return { items, rejected, countTotal, fetchedAt };
  }

  markets(chainId: number): Promise<ParsedPage<ApiMarket>> {
    return this.paged(MARKETS_QUERY, "markets", 200, chainId, apiMarketSchema);
  }

  vaults(chainId: number): Promise<ParsedPage<ApiVault>> {
    return this.paged(VAULTS_QUERY, "vaultV2s", 100, chainId, apiVaultSchema);
  }
}
