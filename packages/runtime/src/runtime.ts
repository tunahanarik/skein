/**
 * Composition root: wires config → ChainReader → registry → Price Service → Portfolio Engine.
 * Nothing here signs or sends; there is no private-key input anywhere.
 */
import { existsSync } from "node:fs";
import { CACHE_TTL_MS } from "@skein/core/config/freshness";
import { ViemChainReader, type ChainReader } from "@skein/chain/reader";
import { RpcPriority } from "@skein/chain/priority";
import { resolveRpcConfig, runtimeMode, type RpcConfig } from "@skein/chain/rpcConfig";
import { TtlCache } from "@skein/core/lib/cache";
import { HttpClient } from "@skein/core/lib/http";
import { getPortfolio, type PortfolioOptions } from "@skein/portfolio/engine";
import { OpportunityEngine } from "@skein/engine/opportunities/engine";
import { AssetIntelligenceService } from "@skein/product/service";
import { MorphoAdapter } from "@skein/protocols/morpho/adapter";
import { PendleAdapter } from "@skein/protocols/pendle/adapter";
import { UniswapAdapter } from "@skein/protocols/uniswap/adapter";
import { FilePoolListStore } from "@skein/protocols/uniswap/poolStore";
import { SparkSavingsAdapter } from "@skein/protocols/spark/adapter";
import { UniswapV4Adapter } from "@skein/protocols/uniswap/v4adapter";
import { RAMSES_CL, RAMSES_POOL_CACHE_PATH } from "@skein/protocols/ramses/dialect";
import { BeefyAdapter } from "@skein/protocols/beefy/adapter";
import { SteerAdapter } from "@skein/protocols/steer/adapter";
import { PriceService } from "@skein/pricing/priceService";
import { loadAssetRegistry, type AssetRegistry } from "@skein/robinhood/registry/registry";
import { defaultSnapshotPath, readSnapshotFile, type RegistrySnapshot } from "@skein/robinhood/registry/snapshot";

export interface Runtime {
  rpc: RpcConfig;
  reader: ChainReader;
  /** Lets user-facing requests go ahead of the snapshot's discovery reads (see RpcPriority). */
  priority: RpcPriority;
  http: HttpClient;
  prices: PriceService;
  baseline: RegistrySnapshot | null;
  getRegistry: () => Promise<AssetRegistry>;
  getPortfolio: (wallet: unknown, opts?: PortfolioOptions) => ReturnType<typeof getPortfolio>;
  /** Registered protocol adapters. Adding a protocol = adding an adapter here. */
  opportunities: OpportunityEngine;
  /** Phase 5 product read API (projection of the engine's output). */
  intelligence: AssetIntelligenceService;
}

/** Discovered-pool cache (factory events), re-verified onchain on load. Not committed. */
export const UNISWAP_POOL_CACHE_PATH = ".cache/uniswap-v3-pools-4663.json";

export function createRuntime(env: Record<string, string | undefined> = process.env, opts: { snapshotPath?: string; verifyOnchain?: boolean; poolCachePath?: string } = {}): Runtime {
  const rpc = resolveRpcConfig(env, runtimeMode(env));
  const reader = new ViemChainReader(rpc);
  const http = new HttpClient();
  const prices = new PriceService({ reader, http });
  const path = opts.snapshotPath ?? defaultSnapshotPath();
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

  // Discovery (the periodic snapshot) yields to user-facing reads held by the server; wallet
  // balances, prices and position reads use the plain reader. With no hold active (CLI scripts)
  // the background reader behaves exactly like the plain one.
  const priority = new RpcPriority();
  const backgroundReader = priority.background(reader);
  const backgroundPrices = new PriceService({ reader: backgroundReader, http });
  const engine = new OpportunityEngine([new MorphoAdapter(http), new PendleAdapter(http), new UniswapAdapter({ store: new FilePoolListStore(opts.poolCachePath ?? UNISWAP_POOL_CACHE_PATH) }), new UniswapAdapter({ dialect: RAMSES_CL, store: new FilePoolListStore(RAMSES_POOL_CACHE_PATH) }), new UniswapV4Adapter(), new SparkSavingsAdapter(), new BeefyAdapter(http), new SteerAdapter(http)], { reader: backgroundReader, getRegistry, prices: backgroundPrices });
  const portfolioFn: Runtime["getPortfolio"] = (wallet, o) => getPortfolio(wallet, { reader, getRegistry, prices, isPublicRpc: rpc.isPublicRpc }, o);
  return {
    rpc,
    reader,
    priority,
    http,
    prices,
    baseline,
    getRegistry,
    getPortfolio: portfolioFn,
    opportunities: engine,
    intelligence: new AssetIntelligenceService({ engine, getPortfolio: (w) => portfolioFn(w), foregroundReader: reader, prices }),
  };
}
