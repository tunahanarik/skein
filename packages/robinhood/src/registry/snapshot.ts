/**
 * Local verified registry snapshot: for development, tests, degraded operation and change
 * detection. It is never presented as live data — the loader reports its age and mode.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { ROBINHOOD_CHAIN_ID } from "@skein/networks/chains";
import { RHJ_ASSETS_URL, type StockRegistryEntry } from "./robinhoodRegistry.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;
/** Committed baseline, shipped inside this package (packages/robinhood/data/registry). Resolved on use, not at import. */
export const defaultSnapshotPath = (): string => fileURLToPath(new URL("../../data/registry/robinhood-stock-tokens.snapshot.json", import.meta.url));

export interface RegistrySnapshot {
  schemaVersion: number;
  source: string;
  chainId: number;
  /** When this file was written. */
  generatedAt: string;
  /** When the upstream response it was built from was fetched. */
  sourceFetchedAt: string;
  assetCount: number;
  /** sha256 over the canonical JSON of `entries` (addresses lowercased, sorted). */
  contentHash: string;
  entries: StockRegistryEntry[];
}

const bigintStr = z.string().regex(/^[0-9]+$/).transform((s) => BigInt(s));
const entrySchema = z.object({
  address: z.string().refine((s) => isAddress(s, { strict: false })).transform((s) => getAddress(s) as Address),
  uid: z.string().regex(/^0x[0-9a-f]{64}$/).transform((s) => s as Hex),
  symbol: z.string().min(1),
  name: z.string(),
  decimals: z.number().int().min(0).max(36),
  status: z.string(),
  multiplierE18: bigintStr,
  pendingMultiplierE18: bigintStr.nullable(),
  pendingEffectiveAt: z.number().int().nullable(),
  isin: z.string().nullable(),
  logoUrl: z.string().nullable(),
});
const snapshotSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  source: z.string(),
  chainId: z.number().int(),
  generatedAt: z.string(),
  sourceFetchedAt: z.string(),
  assetCount: z.number().int(),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  entries: z.array(entrySchema),
});

function canonicalJson(entries: readonly StockRegistryEntry[]): string {
  const rows = [...entries]
    .map((e) => ({ ...e, address: e.address.toLowerCase(), multiplierE18: e.multiplierE18.toString(), pendingMultiplierE18: e.pendingMultiplierE18?.toString() ?? null }))
    .sort((a, b) => a.address.localeCompare(b.address));
  // fixed key order so the hash is stable across runtimes
  return JSON.stringify(rows, ["address", "uid", "symbol", "name", "decimals", "status", "multiplierE18", "pendingMultiplierE18", "pendingEffectiveAt", "isin", "logoUrl"]);
}

export function registryContentHash(entries: readonly StockRegistryEntry[]): string {
  return "sha256:" + createHash("sha256").update(canonicalJson(entries)).digest("hex");
}

export function buildSnapshot(entries: readonly StockRegistryEntry[], sourceFetchedAt: string, generatedAt = new Date().toISOString()): RegistrySnapshot {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    source: RHJ_ASSETS_URL,
    chainId: ROBINHOOD_CHAIN_ID,
    generatedAt,
    sourceFetchedAt,
    assetCount: entries.length,
    contentHash: registryContentHash(entries),
    entries: [...entries],
  };
}

export class SnapshotError extends Error {
  override readonly name = "SnapshotError";
}

/** Parse and integrity-check a snapshot (schema, chain id, count, hash). */
export function parseSnapshot(json: unknown): RegistrySnapshot {
  const parsed = snapshotSchema.safeParse(json);
  if (!parsed.success) throw new SnapshotError(`snapshot schema: ${parsed.error.message.slice(0, 200)}`);
  const s = parsed.data as RegistrySnapshot;
  if (s.chainId !== ROBINHOOD_CHAIN_ID) throw new SnapshotError(`snapshot is for chain ${s.chainId}`);
  if (s.assetCount !== s.entries.length) throw new SnapshotError("snapshot assetCount does not match entries");
  const hash = registryContentHash(s.entries);
  if (hash !== s.contentHash) throw new SnapshotError(`snapshot content hash mismatch (file edited by hand?)`);
  return s;
}

export function readSnapshotFile(path = defaultSnapshotPath()): RegistrySnapshot {
  return parseSnapshot(JSON.parse(readFileSync(path, "utf8")));
}

export function writeSnapshotFile(s: RegistrySnapshot, path = defaultSnapshotPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const json = JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(path, json + "\n");
}
