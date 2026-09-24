/**
 * Persistence for the DISCOVERED pool list (a cache of factory events, not a curated list).
 * Every pool loaded from it is re-verified onchain (identity checks) before use, so a stale or
 * tampered file can only cost time, never admit an unverified pool. Never committed to git.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { getAddress, isAddress, type Address } from "viem";
import type { DiscoveredPool, PoolIdentity } from "./onchain.js";

export interface PoolListSnapshot {
  version: 1;
  chainId: number;
  factory: string;
  /** Hash of the canonical token set the scan was filtered by; a change forces a full rescan. */
  tokenSetHash: string;
  scannedTo: bigint;
  /** Wall-clock ms when the list was last rescanned; bounds reuse and stale fallback. */
  savedAt: number;
  pools: DiscoveredPool[];
  /**
   * Resumable cold event scan: tasks still to run over [0, target]. `scannedTo` only becomes
   * `target` once no task is pending. Absent/empty = the event scan is complete.
   */
  coldScan?: { target: bigint; pending: string[] } | null;
  /**
   * Onchain identity checks already performed (immutable per v3 pool), keyed by lowercase pool.
   * Re-verified after POOL_IDENTITY. Only fully readable identities are stored.
   */
  identities?: Record<string, PersistedIdentity>;
}

export interface PersistedIdentity {
  identity: PoolIdentity;
  block: { number: bigint; timestamp: bigint };
  verifiedAt: number;
}

export interface PoolListStore {
  load(): PoolListSnapshot | null;
  save(s: PoolListSnapshot): void;
}

export class MemoryPoolListStore implements PoolListStore {
  snapshot: PoolListSnapshot | null = null;
  saves = 0;
  load() {
    return this.snapshot;
  }
  save(s: PoolListSnapshot) {
    this.snapshot = s;
    this.saves++;
  }
}

const addr = z.string().refine((s) => isAddress(s, { strict: false })).transform((s) => getAddress(s) as Address);
const fileSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int(),
  factory: z.string(),
  tokenSetHash: z.string(),
  // -1 while the cold scan has not completed
  scannedTo: z.string().regex(/^-?\d+$/),
  savedAt: z.number().int().nonnegative(),
  pools: z.array(
    z.object({ pool: addr, token0: addr, token1: addr, fee: z.number().int(), tickSpacing: z.number().int(), createdAtBlock: z.string().regex(/^\d+$/).nullable(), via: z.enum(["EVENT", "FACTORY_GETPOOL"]) }),
  ),
  coldScan: z.object({ target: z.string().regex(/^\d+$/), pending: z.array(z.string()) }).nullable().optional(),
  identities: z
    .record(
      z.string(),
      z.object({
        identity: z.object({
          pool: addr,
          token0: addr,
          token1: addr,
          fee: z.number().int(),
          tickSpacing: z.number().int(),
          meta: z.record(z.string(), z.object({ decimals: z.number().int().nullable(), symbol: z.string().max(200).nullable() })),
          checks: z.array(z.object({ check: z.string(), ok: z.boolean().nullable(), detail: z.string() })),
          readAtBlock: z.string().regex(/^\d+$/),
        }),
        block: z.object({ number: z.string().regex(/^\d+$/), timestamp: z.string().regex(/^\d+$/) }),
        verifiedAt: z.number().int().nonnegative(),
      }),
    )
    .optional(),
});

/** JSON file store; a malformed file is ignored (full rescan), never trusted partially. */
export class FilePoolListStore implements PoolListStore {
  constructor(private readonly path: string) {}
  load(): PoolListSnapshot | null {
    try {
      const p = fileSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (!p.success) return null;
      return {
        ...p.data,
        version: 1,
        scannedTo: BigInt(p.data.scannedTo),
        pools: p.data.pools.map((x) => ({ ...x, createdAtBlock: x.createdAtBlock === null ? null : BigInt(x.createdAtBlock) })),
        coldScan: p.data.coldScan ? { target: BigInt(p.data.coldScan.target), pending: p.data.coldScan.pending } : null,
        identities: Object.fromEntries(
          Object.entries(p.data.identities ?? {}).map(([k, v]) => [
            k.toLowerCase(),
            { identity: { ...v.identity, readAtBlock: BigInt(v.identity.readAtBlock) }, block: { number: BigInt(v.block.number), timestamp: BigInt(v.block.timestamp) }, verifiedAt: v.verifiedAt },
          ]),
        ),
      };
    } catch {
      return null;
    }
  }
  save(s: PoolListSnapshot): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    renameSync(tmp, this.path);
  }
}
