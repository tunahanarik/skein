/**
 * Price the canonical assets an adapter touches, through the Phase 1 Price Service only.
 * Stock Tokens get their onchain uiMultiplier (read at the context block) passed in, exactly as
 * Phase 1 defines — this helper never applies a multiplier itself. Non-canonical assets are
 * never priced.
 *
 * (The Morpho adapter predates this helper and keeps its own identical inline version; Phase 3
 * does not touch Morpho behaviour.)
 */
import { stockTokenAbi } from "../config/abis.js";
import type { DataSource } from "../model/provenance.js";
import type { Warning } from "../model/warnings.js";
import type { PriceRequest } from "../pricing/priceService.js";
import type { UsdPrice } from "../pricing/types.js";
import type { AdapterContext } from "./adapter.js";

export interface AssetPrice {
  price: UsdPrice | null;
  isChainlink: boolean;
  /** uiMultiplier read onchain (Stock Tokens only). */
  multiplier: bigint | null;
}

export async function priceCanonicalAssets(ctx: AdapterContext, keys: Iterable<string>): Promise<{ priceOf: (key: string) => AssetPrice; warnings: Warning[] }> {
  const wanted = new Set([...keys].map((k) => k.toLowerCase()));
  const assets = ctx.registry.canonical().filter((a) => wanted.has(a.key.toLowerCase()) && a.address !== null);
  const stocks = assets.filter((a) => a.type === "STOCK_TOKEN");
  const mults = stocks.length ? await ctx.reader.multicall(stocks.map((a) => ({ address: a.address!, abi: stockTokenAbi, functionName: "uiMultiplier" })), { blockNumber: ctx.blockNumber }) : [];
  const multiplierByKey = new Map<string, bigint>();
  stocks.forEach((a, i) => {
    const r = mults[i];
    if (r?.status === "success" && (r.result as bigint) > 0n) multiplierByKey.set(a.key, r.result as bigint);
  });
  const observedAt = ctx.now().toISOString();
  const requests: PriceRequest[] = assets.map((asset) => {
    const m = multiplierByKey.get(asset.key);
    const src: DataSource = { type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract: asset.address!, method: "uiMultiplier()", blockNumber: ctx.blockNumber, observedAt };
    return { asset, ...(m ? { multiplier: { valueE18: m, source: "ONCHAIN" as const, provenance: src } } : {}) };
  });
  const priced = requests.length ? await ctx.prices.priceAssets(requests, { blockNumber: ctx.blockNumber }) : null;
  return {
    priceOf: (key: string) => {
      const q = priced?.quotes.get(key);
      return {
        price: q?.status === "PRICED" ? q.priceUsd : null,
        isChainlink: q?.method === "CHAINLINK_STOCK_TOKEN_FEED" || q?.method === "CHAINLINK_USDG_USD" || q?.method === "CHAINLINK_ETH_USD",
        multiplier: multiplierByKey.get(key) ?? null,
      };
    },
    warnings: priced?.warnings ?? [],
  };
}
