/**
 * Pendle official API client (https://api-v2.pendle.finance/core). Read-only, keyless.
 *
 * Verified 2026-09-24: /v1/chains includes 4663. We use ONE endpoint, per market:
 *   GET /v1/{chainId}/markets/{address}
 * because it is the only one carrying `dataUpdatedAt` (the list endpoints do not), and it also
 * answers for markets the Pendle app does not list (discovery is onchain, not from this API).
 * Field meanings are Pendle's OpenAPI descriptions (docs/pendle-semantics.md). Only fields we
 * use are validated; strings from the API are display-only and sanitized before use.
 *
 * The URL is built from a fixed base + a chain id + a checksummed address; nothing from a
 * response is ever used to build a request.
 */
import { z } from "zod";
import { getAddress, isAddress, type Address } from "viem";
import type { HttpClient } from "../../lib/http.js";

export const PENDLE_API_BASE = "https://api-v2.pendle.finance/core";

const addr = z.string().refine((s) => isAddress(s, { strict: false }), "invalid address").transform((s) => getAddress(s) as Address);
const num = z.number().finite().nullable().optional().transform((v) => v ?? null);
const str = z.string().nullable().optional().transform((v) => v ?? null);
const bool = z.boolean().nullable().optional().transform((v) => v ?? null);
const token = z.object({ address: addr, symbol: z.string().optional(), decimals: z.number().int().min(0).max(36).optional() }).passthrough();

export const pendleMarketSchema = z.object({
  address: addr,
  chainId: z.number().int(),
  expiry: z.string(),
  pt: token,
  yt: token,
  sy: token,
  accountingAsset: token.nullable().optional().transform((v) => v ?? null),
  rewardTokens: z.array(token).nullable().optional().transform((v) => v ?? []),
  inputTokens: z.array(token).nullable().optional().transform((v) => v ?? []),
  isWhitelistedPro: bool,
  isWhitelistedSimple: bool,
  isActive: bool,
  liquidity: z.object({ usd: num, acc: num }).nullable().optional().transform((v) => v ?? null),
  totalPt: num,
  totalSy: num,
  underlyingInterestApy: num,
  underlyingRewardApy: num,
  underlyingRewardApyBreakdown: z
    .array(z.object({ asset: z.object({ address: addr, symbol: z.string().optional() }).passthrough(), absoluteApy: num, source: str }).passthrough())
    .nullable()
    .optional()
    .transform((v) => v ?? []),
  underlyingApy: num,
  impliedApy: num,
  ytFloatingApy: num,
  ptDiscount: num,
  swapFeeApy: num,
  pendleApy: num,
  lpRewardApy: num,
  aggregatedApy: num,
  maxBoostedApy: num,
  ytRoi: num,
  ptRoi: num,
  dataUpdatedAt: str,
  extendedInfo: z
    .object({ pyUnit: str, ptEqualsPyUnit: bool, feeRate: num })
    .passthrough()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
});
export type PendleApiMarket = z.infer<typeof pendleMarketSchema>;

export interface PendleApiResult {
  market: PendleApiMarket;
  fetchedAt: string;
  url: string;
}

export interface PendleApi {
  /** One market's state. Throws on transport/schema errors (caller isolates per market). */
  market(chainId: number, market: Address): Promise<PendleApiResult>;
}

export class PendleApiClient implements PendleApi {
  constructor(
    private readonly http: HttpClient,
    private readonly base: string = PENDLE_API_BASE,
  ) {}

  async market(chainId: number, market: Address): Promise<PendleApiResult> {
    if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("invalid chain id");
    const url = `${this.base}/v1/${chainId}/markets/${getAddress(market)}`;
    const res = await this.http.getJson(url, pendleMarketSchema, { maxBytes: 1_000_000, timeoutMs: 15_000 });
    if (res.data.address.toLowerCase() !== market.toLowerCase() || res.data.chainId !== chainId) throw new Error(`Pendle API answered for a different market/chain`);
    return { market: res.data, fetchedAt: res.fetchedAt, url };
  }
}
