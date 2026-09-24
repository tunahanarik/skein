/**
 * Composition root: wires config → ChainReader → registry → Price Service → Portfolio Engine.
 * Nothing here signs or sends; there is no private-key input anywhere.
 */
import { existsSync } from "node:fs";
import { CACHE_TTL_MS } from "./config/freshness.js";
import { ViemChainReader, type ChainReader } from "./chain/reader.js";
import { resolveRpcConfig, runtimeMode, type RpcConfig } from "./chain/rpcConfig.js";
import { TtlCache } from "./lib/cache.js";
import { HttpClient } from "./lib/http.js";
import { getPortfolio, type PortfolioOptions } from "./portfolio/engine.js";
import { OpportunityEngine } from "./opportunities/engine.js";
import { MorphoAdapter } from "./protocols/morpho/adapter.js";
import { PriceService } from "./pricing/priceService.js";
import { loadAssetRegistry, type AssetRegistry } from "./registry/registry.js";
import { DEFAULT_SNAPSHOT_PATH, readSnapshotFile, type RegistrySnapshot } from "./registry/snapshot.js";

export interface Runtime {
  rpc: RpcConfig;
  reader: ChainReader;
  http: HttpClient;
  prices: PriceService;
  baseline: RegistrySnapshot | null;
  getRegistry: () => Promise<AssetRegistry>;
  getPortfolio: (wallet: unknown, opts?: PortfolioOptions) => ReturnType<typeof getPortfolio>;
  /** Registered protocol adapters. Adding a protocol = adding an adapter here. */
  opportunities: OpportunityEngine;
}

export function createRuntime(env: Record<string, string | undefined> = process.env, opts: { snapshotPath?: string; verifyOnchain?: boolean } = {}): Runtime {
  const rpc = resolveRpcConfig(env, runtimeMode(env));
  const reader = new ViemChainReader(rpc);
  const http = new HttpClient();
  const prices = new PriceService({ reader, http });
  const path = opts.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
  const baseline = existsSync(path) ? readSnapshotFile(path) : null;

  // The built registry (including its onchain identity check) is cached as a whole.
  const cache = new TtlCache<AssetRegistry>();
  const getRegistry = () =>
    cache.getOrLoad("registry", CACHE_TTL_MS.ASSET_REGISTRY, async () => {
      await reader.assertChainId();
      const verify = opts.verifyOnchain ?? true;
      const blockNumber = verify ? (await reader.getLatestBlock()).number : undefined;
      return loadAssetRegistry({ http, baseline, ...(verify ? { reader, blockNumber: blockNumber! } : {}) });
    });

  return {
    rpc,
    reader,
    http,
    prices,
    baseline,
    getRegistry,
    getPortfolio: (wallet, o) => getPortfolio(wallet, { reader, getRegistry, prices, isPublicRpc: rpc.isPublicRpc }, o),
    opportunities: new OpportunityEngine([new MorphoAdapter(http)], { reader, getRegistry, prices }),
  };
}
