/**
 * Robinhood Stock Token registry ingestion: fetch → validate → normalize → cache.
 * Source (Phase 0, docs /chain/contracts + /chain/stock-token-apis): GET /rhj/assets.
 * A token is canonical iff its address is in this list, ACTIVE, on chain 4663.
 */
import { getAddress, type Address, type Hex } from "viem";
import { ROBINHOOD_CHAIN_ID } from "@skein/networks/chains";
import { CACHE_TTL_MS } from "@skein/core/config/freshness";
import { TtlCache } from "@skein/core/lib/cache";
import type { HttpClient } from "@skein/core/lib/http";
import { parseMultiplier } from "@skein/core/lib/stockToken";
import { sanitizeLabel } from "@skein/core/lib/sanitize";
import { rhjAssetsResponseSchema, RHJ_BASE_URL, type RhjAsset } from "../sources/robinhood.js";

export const RHJ_ASSETS_URL = `${RHJ_BASE_URL}/assets`;
/** /rhj/assets was 163 KB on 2026-09-24; 2 MB leaves room for growth and caps abuse. */
const MAX_REGISTRY_BYTES = 2_000_000;
/** Docs: "Each Stock Token is a standard ERC-20 contract with 18 decimals." */
export const STOCK_TOKEN_DECIMALS = 18;

/** One normalized Stock Token, as stored in snapshots and compared by the differ. */
export interface StockRegistryEntry {
  address: Address; // checksummed
  uid: Hex; // lowercase bytes32
  symbol: string;
  name: string;
  decimals: number;
  status: string;
  multiplierE18: bigint;
  pendingMultiplierE18: bigint | null;
  pendingEffectiveAt: number | null;
  isin: string | null;
  logoUrl: string | null;
}

export type RegistryIssueCode =
  | "DUPLICATE_ADDRESS"
  | "DUPLICATE_UID"
  | "DUPLICATE_SYMBOL"
  | "BAD_MULTIPLIER"
  | "BAD_PENDING_MULTIPLIER"
  | "UNEXPECTED_DECIMALS"
  | "NO_CHAIN_DEPLOYMENT"
  | "MULTIPLE_CHAIN_DEPLOYMENTS"
  | "NOT_ACTIVE";

export interface RegistryIssue {
  code: RegistryIssueCode;
  /** Symbol / uid / address that triggered it, as reported upstream. */
  subject: string;
  detail: string;
  /** EXCLUDED = entry dropped from the canonical set; FLAGGED = kept, but surfaced. */
  effect: "EXCLUDED" | "FLAGGED";
}

export interface RawRegistryFetch {
  assets: RhjAsset[];
  url: string;
  fetchedAt: string;
  bytes: number;
}

export interface ValidatedRegistry {
  entries: StockRegistryEntry[];
  issues: RegistryIssue[];
  fetchedAt: string;
  url: string;
}

export async function fetchRobinhoodAssetRegistry(http: HttpClient): Promise<RawRegistryFetch> {
  const res = await http.getJson(RHJ_ASSETS_URL, rhjAssetsResponseSchema, { maxBytes: MAX_REGISTRY_BYTES });
  return { assets: res.data.assets, url: res.url, fetchedAt: res.fetchedAt, bytes: res.bytes };
}

/** Only https URLs on Robinhood's CDN are kept as logo URLs; anything else is dropped. */
function safeLogoUrl(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" && url.hostname === "cdn.robinhood.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Normalize one upstream asset. Returns the entry or the reason it cannot be used.
 * Does not decide canonicality by itself — `validateRobinhoodAssetRegistry` does, across entries.
 */
export function normalizeRobinhoodAsset(
  a: RhjAsset,
  chainId: number = ROBINHOOD_CHAIN_ID,
): { entry: StockRegistryEntry; flags: RegistryIssue[] } | { issue: RegistryIssue } {
  const subject = `${a.tokenSymbol} ${a.id}`;
  const onChain = a.deployments.filter((d) => d.chainId === chainId);
  if (onChain.length === 0) return { issue: { code: "NO_CHAIN_DEPLOYMENT", subject, detail: `no deployment on ${chainId}`, effect: "EXCLUDED" } };
  const distinct = new Set(onChain.map((d) => d.contractAddress.toLowerCase()));
  if (distinct.size > 1) {
    return { issue: { code: "MULTIPLE_CHAIN_DEPLOYMENTS", subject, detail: `${distinct.size} addresses on ${chainId}`, effect: "EXCLUDED" } };
  }
  let multiplierE18: bigint;
  try {
    multiplierE18 = parseMultiplier(a.currentMultiplier);
  } catch (e) {
    return { issue: { code: "BAD_MULTIPLIER", subject, detail: `currentMultiplier "${a.currentMultiplier}": ${(e as Error).message}`, effect: "EXCLUDED" } };
  }
  const flags: RegistryIssue[] = [];
  let pendingMultiplierE18: bigint | null = null;
  let pendingEffectiveAt: number | null = null;
  if (a.pendingMultiplier) {
    try {
      pendingMultiplierE18 = parseMultiplier(a.pendingMultiplier);
      const ms = a.pendingMultiplierEffectiveTime ? Date.parse(a.pendingMultiplierEffectiveTime) : Number.NaN;
      pendingEffectiveAt = Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
    } catch (e) {
      flags.push({ code: "BAD_PENDING_MULTIPLIER", subject, detail: (e as Error).message, effect: "FLAGGED" });
    }
  }
  const decimals = a.tokenDecimals ?? STOCK_TOKEN_DECIMALS;
  if (decimals !== STOCK_TOKEN_DECIMALS) {
    flags.push({ code: "UNEXPECTED_DECIMALS", subject, detail: `tokenDecimals ${decimals}, docs say 18`, effect: "FLAGGED" });
  }
  const isin = typeof a.isin === "string" && /^[A-Z0-9]{12}$/.test(a.isin) ? a.isin : null;
  return {
    entry: {
      address: getAddress(onChain[0]!.contractAddress),
      uid: a.id.toLowerCase() as Hex,
      symbol: sanitizeLabel(a.tokenSymbol, 16),
      name: sanitizeLabel(a.tokenName),
      decimals,
      status: a.status,
      multiplierE18,
      pendingMultiplierE18,
      pendingEffectiveAt,
      isin,
      logoUrl: safeLogoUrl(a.logoUrl),
    },
    flags,
  };
}

/**
 * Validate the full list: normalize each entry, then enforce uniqueness of address, uid and
 * symbol. Any collision excludes EVERY entry involved — we cannot tell which one is real.
 * Non-ACTIVE entries are excluded from the canonical set (a status transition, not an error).
 */
export function validateRobinhoodAssetRegistry(raw: RawRegistryFetch, chainId: number = ROBINHOOD_CHAIN_ID): ValidatedRegistry {
  const issues: RegistryIssue[] = [];
  const candidates: StockRegistryEntry[] = [];
  for (const a of raw.assets) {
    const n = normalizeRobinhoodAsset(a, chainId);
    if ("issue" in n) {
      issues.push(n.issue);
      continue;
    }
    issues.push(...n.flags);
    if (n.entry.status !== "ASSET_STATUS_ACTIVE") {
      issues.push({ code: "NOT_ACTIVE", subject: `${n.entry.symbol} ${n.entry.address}`, detail: n.entry.status, effect: "EXCLUDED" });
      continue;
    }
    candidates.push(n.entry);
  }
  const excluded = new Set<StockRegistryEntry>();
  const checkUnique = (code: RegistryIssueCode, keyOf: (e: StockRegistryEntry) => string) => {
    const groups = new Map<string, StockRegistryEntry[]>();
    for (const e of candidates) groups.set(keyOf(e), [...(groups.get(keyOf(e)) ?? []), e]);
    for (const [k, group] of groups) {
      if (group.length < 2) continue;
      group.forEach((e) => excluded.add(e));
      issues.push({ code, subject: k, detail: group.map((e) => `${e.symbol}@${e.address}`).join(", "), effect: "EXCLUDED" });
    }
  };
  checkUnique("DUPLICATE_ADDRESS", (e) => e.address.toLowerCase());
  checkUnique("DUPLICATE_UID", (e) => e.uid);
  checkUnique("DUPLICATE_SYMBOL", (e) => e.symbol);
  const entries = candidates.filter((e) => !excluded.has(e)).sort((a, b) => a.address.toLowerCase().localeCompare(b.address.toLowerCase()));
  return { entries, issues, fetchedAt: raw.fetchedAt, url: raw.url };
}

/**
 * Process-wide cache of the validated live registry (TTL from config/freshness.ts).
 * Snapshot persistence lives in snapshot.ts; this cache only avoids refetching.
 */
const registryCache = new TtlCache<ValidatedRegistry>();

export function cacheRobinhoodAssetRegistry(
  http: HttpClient,
  opts: { ttlMs?: number; chainId?: number; cache?: TtlCache<ValidatedRegistry> } = {},
): Promise<ValidatedRegistry> {
  const cache = opts.cache ?? registryCache;
  return cache.getOrLoad(`rhj-assets:${opts.chainId ?? ROBINHOOD_CHAIN_ID}`, opts.ttlMs ?? CACHE_TTL_MS.ASSET_REGISTRY, async () =>
    validateRobinhoodAssetRegistry(await fetchRobinhoodAssetRegistry(http), opts.chainId),
  );
}
