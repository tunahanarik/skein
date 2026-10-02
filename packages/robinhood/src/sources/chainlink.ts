/**
 * Chainlink feed directory for Robinhood Chain. Robinhood's docs (/chain/oracles-and-price-feeds)
 * name Chainlink as the chain's oracle and defer to Chainlink's addresses page as the source
 * of truth; this JSON is what that page renders.
 */
import { z } from "zod";
import { getAddress, isAddress, type Address } from "viem";

export const CHAINLINK_DIRECTORY_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";

const addr = z.string().refine((s) => isAddress(s, { strict: false })).transform((s) => getAddress(s) as Address);

export const chainlinkFeedSchema = z.looseObject({
  name: z.string(),
  path: z.string(),
  proxyAddress: addr,
  secondaryProxyAddress: addr.nullish(),
  contractAddress: addr.nullish(),
  decimals: z.number().int(),
  heartbeat: z.number().int(), // seconds
  threshold: z.number(), // deviation, percent
  docs: z.looseObject({ productTypeCode: z.string().optional(), marketHours: z.string().optional() }).optional(),
});
export type ChainlinkFeed = z.infer<typeof chainlinkFeedSchema>;
export const chainlinkDirectorySchema = z.array(chainlinkFeedSchema);

/**
 * Stock Token feeds are named "Robinhood <TICKER> / USD" (one exception seen: "Robinhood SGOV-USD").
 * The directory has no token-contract field, so the feed → token link is by ticker only and
 * must be confirmed by a price cross-check against /rhj/prices before it is trusted.
 * `description()` onchain is inconsistent ("RHNVDA / USD" vs "Robinhood AAPL / USD") and is
 * never parsed.
 */
export function stockFeedTicker(feed: ChainlinkFeed): string | null {
  if (feed.docs?.productTypeCode !== "primaryTokenizedPrice") return null;
  const m = /^Robinhood\s+([A-Z0-9.]+)\s*(?:\/|-)\s*USD$/.exec(feed.name.trim());
  return m?.[1] ?? null;
}

export function findFeedByName(feeds: readonly ChainlinkFeed[], name: string): ChainlinkFeed | undefined {
  return feeds.find((f) => f.name.trim() === name);
}
