/**
 * Portfolio Engine: wallet → normalized, sourced, honestly-valued Robinhood Chain portfolio.
 *
 *   wallet ─► Asset Registry ─► Balance Reader (one block) ─► Stock display balance
 *          ─► Price Service ─► normalization ─► Portfolio
 *
 * Read-only. Balances are never cached. Unpriced assets are never counted as $0.
 */
import type { Address } from "viem";
import { ROBINHOOD_CHAIN_ID } from "../config/chains.js";
import type { ChainReader } from "../chain/reader.js";
import { calculateStockDisplayBalance, effectiveMultiplier } from "../lib/stockToken.js";
import { formatFixed, usdValueE18, USD_DECIMALS } from "../lib/units.js";
import { parseWalletAddress } from "../lib/validation.js";
import type { DataSource } from "../model/provenance.js";
import { weakestStatus, type VerificationStatus } from "../model/verification.js";
import { warn, type Warning } from "../model/warnings.js";
import type { PriceRequest, PriceService } from "../pricing/priceService.js";
import type { MultiplierInput } from "../pricing/types.js";
import type { Asset } from "../registry/asset.js";
import type { AssetRegistry } from "../registry/registry.js";
import { RHJ_ASSETS_URL } from "../registry/robinhoodRegistry.js";
import { inspectUnknownToken } from "../registry/unknown.js";
import { readBalances, type BalanceReading } from "./balanceReader.js";
import type { CoverageStatus, Portfolio, PortfolioAsset, StockDisplay } from "./types.js";

export interface PortfolioDeps {
  reader: ChainReader;
  getRegistry: () => Promise<AssetRegistry>;
  prices: PriceService;
  now?: () => Date;
  isPublicRpc?: boolean;
}

export interface PortfolioOptions {
  /** Return zero-balance rows too (debugging / registry validation). Default false. */
  includeZeroBalances?: boolean;
  /** Extra token addresses the caller wants inspected. Always UNKNOWN + unpriced. */
  extraTokens?: readonly string[];
}

const ms = (t: number) => Math.round(performance.now() - t);

function multiplierFor(
  asset: Asset,
  reading: BalanceReading | undefined,
  registry: AssetRegistry,
  nowS: number,
  w: Warning[],
): MultiplierInput | null {
  const meta = asset.stockMetadata!;
  const registryEffective = effectiveMultiplier(
    { current: meta.registryMultiplierE18, ...(meta.pendingMultiplierE18 !== null && meta.pendingEffectiveAt !== null ? { pending: meta.pendingMultiplierE18, pendingEffectiveAt: meta.pendingEffectiveAt } : {}) },
    nowS,
  );
  if (meta.pendingMultiplierE18 !== null) {
    w.push(warn("PENDING_MULTIPLIER", `${asset.symbol}: multiplier change to ${formatFixed(meta.pendingMultiplierE18, 18)} scheduled`, { assetKey: asset.key, details: { pendingEffectiveAt: meta.pendingEffectiveAt } }));
  }
  if (reading?.multiplier?.status === "OK") {
    const onchain = reading.multiplier.valueE18!;
    if (onchain !== registryEffective) {
      w.push(warn("REGISTRY_MULTIPLIER_MISMATCH", `${asset.symbol}: onchain uiMultiplier ${formatFixed(onchain, 18)} ≠ registry ${formatFixed(registryEffective, 18)}; onchain value used`, { assetKey: asset.key }));
    }
    return { valueE18: onchain, source: "ONCHAIN", provenance: { ...reading.source, method: "uiMultiplier()" } };
  }
  // Registry value only while the registry itself is live and fresh; a snapshot multiplier
  // could predate a corporate action.
  if (registry.status.mode === "LIVE" && registry.status.freshness.status === "FRESH") {
    w.push(warn("MULTIPLIER_FROM_REGISTRY", `${asset.symbol}: uiMultiplier() unreadable (${reading?.multiplier?.error ?? "not read"}); using live registry value`, { assetKey: asset.key }));
    const src: DataSource = { type: "OFFICIAL_API", provider: "robinhood-rhj-api", url: RHJ_ASSETS_URL, method: "currentMultiplier", observedAt: registry.status.dataAsOf };
    return { valueE18: registryEffective, source: "REGISTRY", provenance: src };
  }
  w.push(warn("MULTIPLIER_UNAVAILABLE", `${asset.symbol}: no trustworthy uiMultiplier; share-equivalents unavailable`, { assetKey: asset.key }));
  return null;
}

export async function getPortfolio(walletInput: unknown, deps: PortfolioDeps, opts: PortfolioOptions = {}): Promise<Portfolio> {
  const tTotal = performance.now();
  const now = deps.now ?? (() => new Date());
  const wallet: Address = parseWalletAddress(walletInput); // throws ValidationError on bad input
  const warnings: Warning[] = [];

  // ---- registry ----
  const tReg = performance.now();
  const registry = await deps.getRegistry();
  const registryMs = ms(tReg);
  const rs = registry.status;
  if (rs.mode === "SNAPSHOT") warnings.push(warn("REGISTRY_SNAPSHOT_MODE", `live registry unavailable (${rs.liveError}); using local snapshot from ${rs.dataAsOf}`));
  if (rs.freshness.status === "STALE" || rs.freshness.status === "UNKNOWN") {
    warnings.push(warn("REGISTRY_STALE", `asset registry data is ${rs.freshness.ageSeconds ?? "?"}s old (${rs.freshness.status})`, { details: { ageSeconds: rs.freshness.ageSeconds } }));
  }
  for (const c of rs.diff?.changes ?? []) {
    if (c.identity) warnings.push(warn("REGISTRY_CONFLICT", `${c.kind} for ${c.symbol}: ${c.before} → ${c.after}; not trusted until reviewed`, { details: { kind: c.kind } }));
  }
  const nonIdentity = (rs.diff?.changes ?? []).filter((c) => !c.identity);
  if (nonIdentity.length) warnings.push(warn("REGISTRY_CHANGED", `${nonIdentity.length} non-identity registry changes vs snapshot (${[...new Set(nonIdentity.map((c) => c.kind))].join(", ")})`));
  for (const i of rs.issues.filter((x) => x.code !== "NOT_ACTIVE")) {
    warnings.push(warn(i.effect === "EXCLUDED" && i.code.startsWith("DUPLICATE") ? "REGISTRY_CONFLICT" : "REGISTRY_ISSUE", `${i.code} ${i.subject}: ${i.detail} (${i.effect})`));
  }
  for (const m of rs.onchain?.mismatched ?? []) {
    warnings.push(warn("REGISTRY_CONFLICT", `${m.symbol} ${m.address}: onchain identity mismatch (${m.reasons.join(", ")}); excluded`));
  }

  // ---- balances at one block ----
  const tBal = performance.now();
  const block = await deps.reader.getLatestBlock();
  const nowS = Math.floor(now().getTime() / 1000);
  const scan: Asset[] = [...registry.canonical()];
  const unknownInfo = new Map<string, { lookalikeOf: Asset[]; metadataReadable: boolean }>();
  for (const addr of opts.extraTokens ?? []) {
    const address = parseWalletAddress(addr);
    if (registry.get(ROBINHOOD_CHAIN_ID, address)) continue; // already canonical (or excluded by conflict)
    const u = await inspectUnknownToken(deps.reader, registry, address, block.number);
    scan.push(u.asset);
    unknownInfo.set(u.asset.key, { lookalikeOf: u.lookalikeOf, metadataReadable: u.metadataReadable });
  }
  const balances = await readBalances(deps.reader, wallet, scan, block.number, now().toISOString());
  const balancesMs = ms(tBal);

  // ---- multipliers + prices for held assets only ----
  const tPx = performance.now();
  const assetWarnings = new Map<string, Warning[]>(scan.map((a) => [a.key, []]));
  const multipliers = new Map<string, MultiplierInput | null>();
  const held = scan.filter((a) => {
    const r = balances.readings.get(a.key);
    return r?.status === "OK" && r.raw! > 0n;
  });
  for (const a of held) {
    if (a.type === "STOCK_TOKEN") multipliers.set(a.key, multiplierFor(a, balances.readings.get(a.key), registry, nowS, assetWarnings.get(a.key)!));
  }
  const requests: PriceRequest[] = held.map((asset) => ({ asset, multiplier: multipliers.get(asset.key) ?? null }));
  const priced = requests.length ? await deps.prices.priceAssets(requests, { blockNumber: block.number }) : { quotes: new Map(), warnings: [], timings: { directoryMs: 0, roundsMs: 0, quotesMs: 0 } };
  warnings.push(...priced.warnings);
  const pricesMs = ms(tPx);

  // ---- normalization ----
  const tNorm = performance.now();
  const rows: PortfolioAsset[] = [];
  for (const a of scan) {
    const r = balances.readings.get(a.key)!;
    const w = assetWarnings.get(a.key)!;
    const isHeld = r.status === "OK" && r.raw! > 0n;
    if (r.status === "FAILED") w.push(warn("BALANCE_READ_FAILED", `${a.symbol}: ${r.error}`, { assetKey: a.key }));
    if (!isHeld && r.status === "OK" && !opts.includeZeroBalances) continue;

    const unknown = unknownInfo.get(a.key);
    if (a.type === "UNKNOWN") {
      w.push(warn("UNKNOWN_ASSET", `${a.address}: not in the canonical registry; self-reported "${a.symbol}" is untrusted`, { assetKey: a.key }));
      if (unknown?.lookalikeOf.length) {
        w.push(warn("LOOKALIKE_TOKEN", `${a.address} uses symbol "${a.symbol}" of canonical ${unknown.lookalikeOf.map((x) => x.address ?? "native").join(", ")}`, { assetKey: a.key }));
      }
      if (unknown && !unknown.metadataReadable) w.push(warn("UNKNOWN_METADATA_UNREADABLE", `${a.address}: decimals() unreadable; balance cannot be interpreted`, { assetKey: a.key }));
    }
    const decimalsKnown = a.type !== "UNKNOWN" || !!unknown?.metadataReadable;
    const quote = isHeld ? (priced.quotes.get(a.key) ?? null) : null;
    if (quote) w.push(...quote.warnings);

    let stock: StockDisplay | null = null;
    const mult = multipliers.get(a.key);
    if (a.type === "STOCK_TOKEN" && r.status === "OK" && mult) {
      const d = calculateStockDisplayBalance(r.raw!, mult.valueE18, a.decimals);
      stock = {
        uiMultiplierE18: d.uiMultiplierE18,
        uiMultiplier: formatFixed(d.uiMultiplierE18, 18),
        multiplierSource: mult.source,
        displayShareBalanceRaw: d.displayShareBalanceRaw,
        displayShareBalance: formatFixed(d.displayShareBalanceRaw, a.decimals),
        pendingMultiplier: a.stockMetadata?.pendingMultiplierE18 != null ? formatFixed(a.stockMetadata.pendingMultiplierE18, 18) : null,
        pendingEffectiveAt: a.stockMetadata?.pendingEffectiveAt != null ? new Date(a.stockMetadata.pendingEffectiveAt * 1000).toISOString() : null,
      };
    }

    // Value = raw × USD-per-whole-token. The Price Service already put any multiplier inside
    // the price, so nothing here multiplies by uiMultiplier.
    const valueE18 = quote?.status === "PRICED" && quote.priceUsd && r.raw !== null ? usdValueE18(r.raw, a.decimals, quote.priceUsd.raw, quote.priceUsd.decimals) : null;
    const statuses: VerificationStatus[] = [a.verificationStatus];
    if (quote?.status === "PRICED") statuses.push(quote.verificationStatus);
    rows.push({
      asset: { key: a.key, chainId: a.chainId, address: a.address, symbol: a.symbol, name: a.name, decimals: a.decimals, type: a.type, canonical: a.canonical },
      balanceStatus: r.status,
      rawBalance: r.raw,
      displayBalance: r.raw !== null && decimalsKnown ? formatFixed(r.raw, a.decimals) : null,
      stock,
      price: quote,
      pricingStatus: valueE18 !== null ? "PRICED" : "UNPRICED",
      valueUsdE18: valueE18,
      valueUsd: valueE18 !== null ? formatFixed(valueE18, USD_DECIMALS) : null,
      verificationStatus: weakestStatus(statuses),
      warnings: w,
      provenance: [r.source, ...(mult ? [mult.provenance] : []), ...(quote?.provenance ?? []), ...a.provenance.slice(0, 1)],
    });
  }
  rows.sort((x, y) => {
    const dv = (y.valueUsdE18 ?? -1n) - (x.valueUsdE18 ?? -1n);
    return dv !== 0n ? (dv > 0n ? 1 : -1) : x.asset.key.localeCompare(y.asset.key);
  });

  const heldRows = rows.filter((x) => x.balanceStatus === "FAILED" || (x.rawBalance ?? 0n) > 0n);
  const pricedRows = heldRows.filter((x) => x.pricingStatus === "PRICED");
  const failed = heldRows.filter((x) => x.balanceStatus === "FAILED").length;
  const unpriced = heldRows.filter((x) => x.balanceStatus === "OK" && x.pricingStatus === "UNPRICED").length;
  const pricedValue = pricedRows.reduce((s, x) => s + x.valueUsdE18!, 0n);
  const allBalancesFailed = scan.length > 0 && [...balances.readings.values()].every((x) => x.status === "FAILED");
  const coverage: CoverageStatus = allBalancesFailed ? "UNKNOWN" : failed > 0 || unpriced > 0 ? "PARTIAL" : "COMPLETE";

  const rpc = deps.reader.health();
  if (rpc.status === "DEGRADED" || rpc.status === "DOWN") {
    warnings.push(warn("RPC_DEGRADED", `RPC ${rpc.status}: ${rpc.failures} failures, ${rpc.rateLimited} rate-limited, ${rpc.timeouts} timeouts, ${rpc.retries} retries`, { details: { lastError: rpc.lastError } }));
  }
  if (deps.isPublicRpc) warnings.push(warn("PUBLIC_RPC_IN_USE", "public Robinhood Chain RPC in use (rate-limited, not for production)"));
  const normalizationMs = ms(tNorm);

  return {
    chainId: ROBINHOOD_CHAIN_ID,
    walletAddress: wallet,
    blockNumber: block.number,
    blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(),
    assets: rows,
    totals: {
      pricedValueUsdE18: pricedValue,
      pricedValueUsd: formatFixed(pricedValue, USD_DECIMALS),
      pricedAssetCount: pricedRows.length,
      unpricedAssetCount: unpriced,
      failedBalanceCount: failed,
      heldAssetCount: heldRows.length,
    },
    valuationCoverage: {
      pricedAssets: pricedRows.length,
      unpricedAssets: unpriced,
      failedBalances: failed,
      coverageStatus: coverage,
      totalValueUsd: coverage === "COMPLETE" ? formatFixed(pricedValue, USD_DECIMALS) : null,
    },
    registry: {
      mode: rs.mode,
      dataAsOf: rs.dataAsOf,
      freshness: rs.freshness,
      stockTokenCount: rs.stockTokenCount,
      scannedAssetCount: scan.length,
      onchainVerified: rs.onchain?.verified ?? null,
    },
    rpc,
    warnings,
    timingsMs: { registry: registryMs, balances: balancesMs, prices: pricesMs, normalization: normalizationMs, total: ms(tTotal) },
    generatedAt: now().toISOString(),
    provenance: [
      { type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ROBINHOOD_CHAIN_ID, method: `block ${block.number} (${block.hash})`, blockNumber: block.number, observedAt: now().toISOString() },
      { type: "OFFICIAL_API", provider: "robinhood-rhj-api", url: RHJ_ASSETS_URL, method: `registry ${rs.mode}`, observedAt: rs.dataAsOf },
    ],
  };
}

/** JSON-safe form: bigints as decimal strings. */
export function portfolioToJson(p: Portfolio): string {
  return JSON.stringify(p, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
