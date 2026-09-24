/**
 * AssetRegistry: the canonical set of assets the portfolio scans, and the lookup for anything
 * else (UNKNOWN assets). Built from core config + the Robinhood Stock Token list, with a
 * committed snapshot as baseline and degraded-mode fallback.
 */
import type { Address } from "viem";
import { ROBINHOOD_CHAIN_ID } from "../config/chains.js";
import { STOCK_TOKEN_REGISTRY } from "../config/assets.js";
import { erc20Abi, stockTokenAbi } from "../config/abis.js";
import { classifyFreshness, type FreshnessInfo } from "../config/freshness.js";
import type { ChainReader } from "../chain/reader.js";
import type { HttpClient } from "../lib/http.js";
import { sameAddress } from "../lib/validation.js";
import type { DataSource } from "../model/provenance.js";
import { assetKey, type Asset } from "./asset.js";
import { coreAssets } from "./coreAssets.js";
import { diffRegistries, type RegistryDiff } from "./diff.js";
import {
  cacheRobinhoodAssetRegistry,
  RHJ_ASSETS_URL,
  type RegistryIssue,
  type StockRegistryEntry,
  type ValidatedRegistry,
} from "./robinhoodRegistry.js";
import type { RegistrySnapshot } from "./snapshot.js";

export type RegistryMode = "LIVE" | "SNAPSHOT";

export interface OnchainIdentityResult {
  checked: number;
  verified: number;
  mismatched: { address: Address; symbol: string; reasons: string[] }[];
  unreadable: number;
  blockNumber: bigint;
}

export interface RegistryStatus {
  mode: RegistryMode;
  /** Time of the data the registry was built from (live fetch or snapshot's source fetch). */
  dataAsOf: string;
  freshness: FreshnessInfo;
  liveError: string | null;
  snapshot: { generatedAt: string; contentHash: string; assetCount: number } | null;
  issues: RegistryIssue[];
  diff: RegistryDiff | null;
  onchain: OnchainIdentityResult | null;
  stockTokenCount: number;
}

export class AssetRegistry {
  private readonly byKey: Map<string, Asset>;

  constructor(
    readonly assets: readonly Asset[],
    readonly status: RegistryStatus,
  ) {
    this.byKey = new Map(assets.map((a) => [a.key, a]));
  }

  get(chainId: number, address: Address | null): Asset | undefined {
    return this.byKey.get(assetKey(chainId, address));
  }

  /** Assets the portfolio scans: canonical only. Untrusted identity changes are excluded. */
  canonical(): Asset[] {
    return this.assets.filter((a) => a.canonical);
  }

  /** Canonical assets whose symbol equals `symbol`: used to flag look-alike unknown tokens. */
  canonicalBySymbol(symbol: string): Asset[] {
    const s = symbol.trim().toUpperCase();
    return this.assets.filter((a) => a.canonical && a.symbol.toUpperCase() === s);
  }
}

function stockAsset(e: StockRegistryEntry, source: DataSource, canonical: boolean, conflict: boolean): Asset {
  return {
    key: assetKey(ROBINHOOD_CHAIN_ID, e.address),
    chainId: ROBINHOOD_CHAIN_ID,
    address: e.address,
    symbol: e.symbol,
    name: e.name,
    decimals: e.decimals,
    type: "STOCK_TOKEN",
    canonical,
    verificationStatus: conflict ? "CONFLICT" : "VERIFIED_OFFICIAL_API",
    underlying: { symbol: e.symbol, isin: e.isin },
    stockMetadata: {
      uid: e.uid,
      rhSymbol: e.symbol,
      isin: e.isin,
      registryMultiplierE18: e.multiplierE18,
      pendingMultiplierE18: e.pendingMultiplierE18,
      pendingEffectiveAt: e.pendingEffectiveAt,
      status: e.status,
      logoUrl: e.logoUrl,
    },
    priceMethods: ["CHAINLINK_STOCK_TOKEN_FEED", "ROBINHOOD_QUOTE_MID"],
    provenance: [source],
  };
}

/**
 * Check each Stock Token against its own contract in one Multicall3 batch:
 * uid(), symbol(), decimals(), ACCESS_CONTROLLED_REGISTRY(). Matching tokens are upgraded to
 * VERIFIED_ONCHAIN; mismatches become CONFLICT and non-canonical. Unreadable ones keep their
 * API status (an RPC hiccup is not evidence of a problem).
 */
export async function verifyStockTokensOnchain(reader: ChainReader, assets: Asset[], blockNumber: bigint): Promise<OnchainIdentityResult> {
  const stocks = assets.filter((a) => a.type === "STOCK_TOKEN" && a.address && a.stockMetadata);
  const calls = stocks.flatMap((a) => [
    { address: a.address!, abi: stockTokenAbi, functionName: "uid" },
    { address: a.address!, abi: erc20Abi, functionName: "symbol" },
    { address: a.address!, abi: erc20Abi, functionName: "decimals" },
    { address: a.address!, abi: stockTokenAbi, functionName: "ACCESS_CONTROLLED_REGISTRY" },
  ]);
  const res = await reader.multicall(calls, { blockNumber });
  const result: OnchainIdentityResult = { checked: stocks.length, verified: 0, mismatched: [], unreadable: 0, blockNumber };
  stocks.forEach((a, i) => {
    const r = res.slice(i * 4, i * 4 + 4);
    if (r.some((x) => x?.status !== "success" && x?.kind === "RPC")) {
      result.unreadable++;
      return;
    }
    const val = (j: number) => (r[j]?.status === "success" ? r[j].result : undefined);
    const reasons: string[] = [];
    if (String(val(0) ?? "").toLowerCase() !== a.stockMetadata!.uid) reasons.push("uid");
    if (val(1) !== a.symbol) reasons.push(`symbol(${String(val(1))})`);
    if (val(2) !== a.decimals) reasons.push(`decimals(${String(val(2))})`);
    if (!sameAddress(String(val(3) ?? "0x"), STOCK_TOKEN_REGISTRY)) reasons.push("registry");
    const source: DataSource = {
      type: "ONCHAIN",
      provider: "robinhood-chain-rpc",
      chainId: ROBINHOOD_CHAIN_ID,
      contract: a.address!,
      method: "uid()/symbol()/decimals()/ACCESS_CONTROLLED_REGISTRY()",
      blockNumber,
      observedAt: new Date().toISOString(),
    };
    a.provenance.push(source);
    if (reasons.length) {
      a.verificationStatus = "CONFLICT";
      a.canonical = false;
      result.mismatched.push({ address: a.address!, symbol: a.symbol, reasons });
    } else {
      if (a.verificationStatus !== "CONFLICT") a.verificationStatus = "VERIFIED_ONCHAIN";
      result.verified++;
    }
  });
  return result;
}

export interface LoadRegistryDeps {
  http: HttpClient;
  /** Trusted baseline (committed snapshot). Optional only for first-time bootstrap. */
  baseline: RegistrySnapshot | null;
  /** When given, every Stock Token identity is checked onchain at `blockNumber`. */
  reader?: ChainReader;
  blockNumber?: bigint;
  now?: () => Date;
  /** Injected for tests; defaults to the process-wide TTL cache. */
  loadLive?: () => Promise<ValidatedRegistry>;
}

/**
 * Build the registry. Live list first; on failure fall back to the baseline snapshot and say
 * so (mode SNAPSHOT + age). Identity changes vs the baseline are excluded from the canonical
 * set and surfaced in `status.diff`.
 */
export async function loadAssetRegistry(deps: LoadRegistryDeps): Promise<AssetRegistry> {
  const now = deps.now?.() ?? new Date();
  const nowS = Math.floor(now.getTime() / 1000);
  let live: ValidatedRegistry | null = null;
  let liveError: string | null = null;
  try {
    live = await (deps.loadLive ?? (() => cacheRobinhoodAssetRegistry(deps.http)))();
  } catch (e) {
    liveError = (e as Error).message;
  }

  let entries: StockRegistryEntry[];
  let mode: RegistryMode;
  let dataAsOf: string;
  let diff: RegistryDiff | null = null;
  let issues: RegistryIssue[] = [];
  if (live) {
    entries = live.entries;
    mode = "LIVE";
    dataAsOf = live.fetchedAt;
    issues = live.issues;
    if (deps.baseline) diff = diffRegistries(deps.baseline.entries, live.entries);
  } else if (deps.baseline) {
    entries = deps.baseline.entries;
    mode = "SNAPSHOT";
    dataAsOf = deps.baseline.sourceFetchedAt;
  } else {
    throw new Error(`asset registry unavailable: live fetch failed (${liveError}) and no snapshot baseline`);
  }

  const source: DataSource =
    mode === "LIVE"
      ? { type: "OFFICIAL_API", provider: "robinhood-rhj-api", url: RHJ_ASSETS_URL, chainId: ROBINHOOD_CHAIN_ID, method: "assets[]", observedAt: dataAsOf }
      : {
          type: "OFFICIAL_API",
          provider: "robinhood-rhj-api (local snapshot)",
          url: RHJ_ASSETS_URL,
          chainId: ROBINHOOD_CHAIN_ID,
          method: `snapshot ${deps.baseline!.contentHash}`,
          observedAt: deps.baseline!.generatedAt,
          sourceTimestamp: deps.baseline!.sourceFetchedAt,
        };
  const untrusted = diff?.untrustedAddresses ?? new Set<string>();
  const stocks = entries.map((e) => {
    const conflict = untrusted.has(e.address.toLowerCase());
    return stockAsset(e, { ...source }, !conflict, conflict);
  });

  let onchain: OnchainIdentityResult | null = null;
  if (deps.reader && deps.blockNumber !== undefined) {
    onchain = await verifyStockTokensOnchain(deps.reader, stocks, deps.blockNumber);
  }
  const all = [...coreAssets(), ...stocks];
  const status: RegistryStatus = {
    mode,
    dataAsOf,
    freshness: classifyFreshness("ASSET_REGISTRY", Math.floor(Date.parse(dataAsOf) / 1000), nowS),
    liveError,
    snapshot: deps.baseline ? { generatedAt: deps.baseline.generatedAt, contentHash: deps.baseline.contentHash, assetCount: deps.baseline.assetCount } : null,
    issues,
    diff,
    onchain,
    stockTokenCount: stocks.filter((s) => s.canonical).length,
  };
  return new AssetRegistry(all, status);
}
