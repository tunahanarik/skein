/**
 * 24h pool volume from GeckoTerminal's keyless public API — a THIRD_PARTY source (not the protocol,
 * not onchain). Indexing Swap logs ourselves is too heavy for the public RPC (≈ 21k v3 swaps per
 * 34 min observed, P4-5), so volume is shown only with this label and never used for ranking.
 *
 *   GET https://api.geckoterminal.com/api/v2/networks/robinhood/pools/multi/{a,b,…}  (≤ 30 pools)
 *
 * Budget: the keyless tier allows about 30 requests/min. We send at most one request per
 * MIN_GAP_MS, back off BACKOFF_MS after a 429, and cache each pool for CACHE_MS.
 */
import { z } from "zod";
import type { HttpClient } from "../lib/http.js";

export const GECKO_NETWORK = "robinhood";
const BASE = `https://api.geckoterminal.com/api/v2/networks/${GECKO_NETWORK}/pools/multi/`;
const BATCH = 30;
const MIN_GAP_MS = 2_500;
const BACKOFF_MS = 60_000;
const CACHE_MS = 5 * 60_000;

const numStr = z.union([z.string(), z.number()]).nullable().optional().transform((v) => (v === null || v === undefined ? null : Number(v)));
const poolSchema = z
  .object({
    attributes: z
      .object({
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        volume_usd: z.object({ h24: numStr }).passthrough().optional(),
        transactions: z.object({ h24: z.object({ buys: z.number().optional(), sells: z.number().optional() }).passthrough().optional() }).passthrough().optional(),
      })
      .passthrough(),
  })
  .passthrough();
const multiSchema = z.object({ data: z.array(z.unknown()) }).transform((o) => o.data.flatMap((x) => {
  const r = poolSchema.safeParse(x);
  return r.success ? [r.data] : [];
}));

export interface PoolVolume {
  usd24h: number | null;
  txs24h: number | null;
  observedAt: string;
  source: "GeckoTerminal";
  url: string;
}

export interface VolumeSource {
  /** Volumes for the given pool addresses; pools it cannot answer (yet) are absent. */
  get(pools: readonly string[], opts?: { timeoutMs?: number }): Promise<Map<string, PoolVolume>>;
}

export class GeckoTerminalVolumes implements VolumeSource {
  private readonly cache = new Map<string, { v: PoolVolume | null; at: number }>();
  private lastRequest = 0;
  private blockedUntil = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly http: HttpClient, private readonly now: () => number = Date.now) {}

  async get(pools: readonly string[], opts: { timeoutMs?: number } = {}): Promise<Map<string, PoolVolume>> {
    const want = [...new Set(pools.map((p) => p.toLowerCase()))].filter((p) => /^0x[0-9a-f]{40}$/.test(p));
    const t = this.now();
    const missing = want.filter((p) => {
      const c = this.cache.get(p);
      return !c || t - c.at > CACHE_MS;
    });
    const fetching = missing.length ? this.fetchAll(missing) : Promise.resolve();
    // Never hold a page for the third party: wait at most timeoutMs, then answer from cache.
    await Promise.race([fetching.catch(() => undefined), new Promise((r) => setTimeout(r, opts.timeoutMs ?? 2_500))]);
    const out = new Map<string, PoolVolume>();
    for (const p of want) {
      const c = this.cache.get(p);
      if (c?.v) out.set(p, c.v);
    }
    return out;
  }

  /** Serialized so concurrent callers never exceed the request budget. */
  private fetchAll(pools: string[]): Promise<void> {
    const run = async () => {
      for (let i = 0; i < pools.length; i += BATCH) {
        const batch = pools.slice(i, i + BATCH).filter((p) => {
          const c = this.cache.get(p);
          return !c || this.now() - c.at > CACHE_MS;
        });
        if (!batch.length) continue;
        if (this.now() < this.blockedUntil) return;
        const wait = this.lastRequest + MIN_GAP_MS - this.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastRequest = this.now();
        const url = BASE + batch.join(",");
        try {
          const r = await this.http.getJson(url, multiSchema, { maxBytes: 2_000_000, retries: 0, timeoutMs: 8_000 });
          const seen = new Set<string>();
          for (const p of r.data) {
            const a = p.attributes;
            const tx = a.transactions?.h24;
            const v: PoolVolume = { usd24h: a.volume_usd?.h24 ?? null, txs24h: tx ? (tx.buys ?? 0) + (tx.sells ?? 0) : null, observedAt: r.fetchedAt, source: "GeckoTerminal", url: `https://www.geckoterminal.com/${GECKO_NETWORK}/pools/${a.address.toLowerCase()}` };
            this.cache.set(a.address.toLowerCase(), { v, at: this.now() });
            seen.add(a.address.toLowerCase());
          }
          // Pools GeckoTerminal does not know: remember briefly so we do not re-ask each request.
          for (const p of batch) if (!seen.has(p)) this.cache.set(p, { v: null, at: this.now() });
        } catch (e) {
          if (/\b429\b/.test((e as Error).message)) this.blockedUntil = this.now() + BACKOFF_MS;
          return;
        }
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }
}
