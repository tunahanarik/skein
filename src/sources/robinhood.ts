/**
 * Robinhood Stock Token REST API (https://api.robinhood.com/rhj/, docs /chain/stock-token-apis).
 * No auth; documented limit 60 req/s; no cache headers are returned, so callers self-throttle.
 *
 * The live schema has drifted from the docs (extra fields, different tradingCapabilities
 * shape), so schemas are permissive about unknown keys and strict only about what we use.
 */
import { z } from "zod";
import { getAddress, isAddress, type Address } from "viem";

export const RHJ_BASE_URL = "https://api.robinhood.com/rhj";

const addressSchema = z
  .string()
  .refine((s) => isAddress(s, { strict: false }), "invalid address")
  .transform((s) => getAddress(s) as Address);

const deploymentSchema = z.looseObject({
  contractAddress: addressSchema,
  chainId: z.number().int(),
});

export const rhjAssetSchema = z.looseObject({
  id: z.string().regex(/^0x[0-9a-f]{64}$/i), // bytes32, equals onchain uid()
  tokenSymbol: z.string().min(1),
  tokenName: z.string(),
  deployments: z.array(deploymentSchema).min(1),
  currentMultiplier: z.string(),
  pendingMultiplier: z.string().optional(),
  pendingMultiplierEffectiveTime: z.string().optional(),
  status: z.string(), // ASSET_STATUS_ACTIVE | ASSET_STATUS_INACTIVE | ASSET_STATUS_UNSPECIFIED
  tokenDecimals: z.number().int().optional(), // live-only field (all 18 at research time)
  logoUrl: z.string().optional(),
});
export type RhjAsset = z.infer<typeof rhjAssetSchema>;

export const rhjAssetsResponseSchema = z.looseObject({ assets: z.array(rhjAssetSchema) });

export const rhjQuoteSchema = z.looseObject({
  tokenSymbol: z.string(),
  bid: z.string(),
  ask: z.string(),
  currency: z.string(),
  isTradingHalt: z.boolean(),
  generatedAt: z.string(),
  deployments: z.array(deploymentSchema).optional(),
});
export type RhjQuote = z.infer<typeof rhjQuoteSchema>;

export const rhjPricesResponseSchema = z.looseObject({ quotes: z.array(rhjQuoteSchema) });

/**
 * Canonical Stock Token set for a chain: address → asset. Per docs /chain/contracts, a token
 * with a matching name or ticker at a different address is NOT a Robinhood Stock Token.
 */
export function canonicalStockTokens(assets: readonly RhjAsset[], chainId: number): Map<Address, RhjAsset> {
  const out = new Map<Address, RhjAsset>();
  for (const a of assets) {
    if (a.status !== "ASSET_STATUS_ACTIVE") continue;
    for (const d of a.deployments) if (d.chainId === chainId) out.set(d.contractAddress, a);
  }
  return out;
}

/** Pending multiplier as a snapshot field, or undefined when the API reports none ("" / absent). */
export function pendingMultiplierOf(a: RhjAsset): { value: string; effectiveAt: number } | undefined {
  if (!a.pendingMultiplier || !a.pendingMultiplierEffectiveTime) return undefined;
  const ms = Date.parse(a.pendingMultiplierEffectiveTime);
  if (!Number.isFinite(ms)) return undefined;
  return { value: a.pendingMultiplier, effectiveAt: Math.floor(ms / 1000) };
}
