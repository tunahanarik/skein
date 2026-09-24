/**
 * Morpho adapter (reference implementation of OpportunityAdapter). Read-only.
 *
 * Caches:
 *   config  onchain-verified market params (immutable per Morpho market) — kept for the process
 *   state   Morpho API markets + vaults — TTL CACHE_TTL_MS.PROTOCOL_MARKET_STATE; on refresh
 *           failure the last good state is served for up to PROTOCOL_STATE_STALE_FALLBACK and the
 *           result is marked PARTIAL. Failures are never cached.
 * Onchain totals, oracle prices and vault totals are read fresh at the context block every run.
 */
import type { Address, Hex } from "viem";
import { parseAbi } from "viem";
import { ROBINHOOD_CHAIN_ID } from "../../config/chains.js";
import { stockTokenAbi } from "../../config/abis.js";
import { CACHE_TTL_MS, classifyFreshness } from "../../config/freshness.js";
import type { HttpClient } from "../../lib/http.js";
import { TtlCache } from "../../lib/cache.js";
import { formatFixed, usdValueE18, USD_DECIMALS } from "../../lib/units.js";
import { ratio18, mulDivDown } from "../../lib/fixed.js";
import type { AssetRef, Opportunity, OpportunityCategory } from "../../model/opportunity.js";
import type { Position } from "../../model/position.js";
import type { DataSource } from "../../model/provenance.js";
import { weakestStatus } from "../../model/verification.js";
import { warn, type Warning } from "../../model/warnings.js";
import type { AdapterCapabilities, AdapterContext, AdapterIssue, AdapterResult, OpportunityAdapter, ResultStatus } from "../../opportunities/adapter.js";
import type { PriceRequest } from "../../pricing/priceService.js";
import { assetKey } from "../../registry/asset.js";
import { sanitizeLabel } from "../../registry/robinhoodRegistry.js";
import { MorphoApiClient, type ApiMarket, type ApiVault, type MorphoApi, type ParsedPage } from "./api.js";
import { normalizeMarket, PROTOCOL, type NormalizeContext, type PricedAsset } from "./normalize.js";
import {
  maxBorrowAssets,
  MORPHO_ADDRESS,
  ORACLE_PRICE_SCALE,
  readMarkets,
  readOraclePrices,
  readPositions,
  readVaultShares,
  readVaultTotals,
  toAssetsDown,
  toAssetsUp,
  type MarketParams,
} from "./onchain.js";
import { normalizeVault, VAULT_V2_FACTORY } from "./vaults.js";

interface ApiState {
  markets: ParsedPage<ApiMarket>;
  vaults: ParsedPage<ApiVault> | null;
  vaultsError: string | null;
  storedAt: number;
}

interface Snapshot {
  opportunities: Opportunity[];
  warnings: Warning[];
  issues: AdapterIssue[];
  status: ResultStatus;
  timingsMs: Record<string, number>;
  /** Context needed by positions (shares→assets, oracle prices). */
  markets: Map<Hex, { api: ApiMarket; params: MarketParams; totals: { totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint } | null; oraclePrice: bigint | null }>;
  vaults: ApiVault[];
  normalizeCtx: NormalizeContext;
}

const factoryAbi = parseAbi(["function isVaultV2(address) view returns (bool)"]);
const ms = (t: number) => Math.round(performance.now() - t);

export interface MorphoAdapterOptions {
  api?: MorphoApi;
  now?: () => number;
}

export class MorphoAdapter implements OpportunityAdapter {
  readonly protocol = { ...PROTOCOL };
  readonly categories: readonly OpportunityCategory[] = ["LEND", "COLLATERAL", "VAULT"];
  readonly capabilities: AdapterCapabilities = { discovery: true, assetFiltering: false, userPositions: true, singleOpportunity: true, execution: false };

  private readonly api: MorphoApi;
  private readonly clock: () => number;
  private readonly stateCache: TtlCache<ApiState>;
  /** Immutable market params, verified onchain: marketId → params + block read at. */
  private readonly configCache = new Map<Hex, { params: MarketParams; block: { number: bigint; timestamp: bigint } }>();

  constructor(http: HttpClient, opts: MorphoAdapterOptions = {}) {
    this.api = opts.api ?? new MorphoApiClient(http);
    this.clock = opts.now ?? (() => Date.now());
    this.stateCache = new TtlCache<ApiState>(this.clock);
  }

  supportsCategory(c: OpportunityCategory): boolean {
    return this.categories.includes(c);
  }

  /** API state with stale-on-error fallback. Throws only if there is nothing usable. */
  private async loadState(issues: AdapterIssue[], warnings: Warning[]): Promise<ApiState> {
    try {
      return await this.stateCache.getOrLoad("state", CACHE_TTL_MS.PROTOCOL_MARKET_STATE, async () => {
        const markets = await this.api.markets(ROBINHOOD_CHAIN_ID);
        let vaults: ParsedPage<ApiVault> | null = null;
        let vaultsError: string | null = null;
        try {
          vaults = await this.api.vaults(ROBINHOOD_CHAIN_ID);
        } catch (e) {
          vaultsError = (e as Error).message;
        }
        return { markets, vaults, vaultsError, storedAt: this.clock() };
      });
    } catch (e) {
      const stale = this.stateCache.getStale("state");
      if (stale && this.clock() - stale.value.storedAt <= CACHE_TTL_MS.PROTOCOL_STATE_STALE_FALLBACK) {
        issues.push({ scope: "morpho-api", message: `refresh failed (${(e as Error).message}); serving state from ${new Date(stale.value.storedAt).toISOString()}`, severity: "DEGRADED" });
        warnings.push(warn("STALE_PROTOCOL_DATA", `Morpho API unavailable; using cached state ${Math.round((this.clock() - stale.value.storedAt) / 1000)}s old`));
        return stale.value;
      }
      throw e;
    }
  }

  private async snapshot(ctx: AdapterContext): Promise<Snapshot> {
    const timingsMs: Record<string, number> = {};
    const issues: AdapterIssue[] = [];
    const warnings: Warning[] = [];
    const nowS = Math.floor(ctx.now().getTime() / 1000);
    const generatedAt = ctx.now().toISOString();

    let t = performance.now();
    const state = await this.loadState(issues, warnings);
    timingsMs.api = ms(t);
    for (const r of state.markets.rejected) issues.push({ scope: `morpho-api market #${r.index}`, message: `malformed item skipped: ${r.error}`, severity: "DEGRADED" });
    if (state.vaultsError) issues.push({ scope: "morpho-api vaults", message: state.vaultsError, severity: "DEGRADED" });
    for (const r of state.vaults?.rejected ?? []) issues.push({ scope: `morpho-api vault #${r.index}`, message: `malformed item skipped: ${r.error}`, severity: "DEGRADED" });
    if (state.markets.countTotal !== null && state.markets.countTotal > state.markets.items.length + state.markets.rejected.length) {
      issues.push({ scope: "morpho-api markets", message: `API reports ${state.markets.countTotal} markets, received ${state.markets.items.length + state.markets.rejected.length}`, severity: "DEGRADED" });
    }

    // De-duplicate markets by id (pagination overlaps would otherwise double-count).
    const byId = new Map<Hex, ApiMarket>();
    for (const m of state.markets.items) {
      if (byId.has(m.marketId as Hex)) warnings.push(warn("DUPLICATE_MARKET", `market ${m.marketId.slice(0, 10)}… returned twice by the API; first kept`));
      else byId.set(m.marketId as Hex, m);
    }
    const ids = [...byId.keys()];

    // ---- onchain: params (only for markets not yet verified), totals, oracle prices ----
    t = performance.now();
    const needParams = new Set(ids.filter((id) => !this.configCache.has(id)));
    const chain = await readMarkets(ctx.reader, ids, ctx.blockNumber, needParams);
    for (const id of needParams) {
      const p = chain.get(id)?.params;
      // Only real markets are cached as immutable; an empty result could be created later.
      if (p && !/^0x0{40}$/i.test(p.loanToken)) this.configCache.set(id, { params: p, block: { number: ctx.blockNumber, timestamp: ctx.blockTimestamp } });
    }
    const paramsOf = (id: Hex) => this.configCache.get(id) ?? null;
    const oracles = ids.map((id) => paramsOf(id)?.params.oracle).filter((o): o is Address => !!o && !/^0x0{40}$/i.test(o));
    const oraclePrices = await readOraclePrices(ctx.reader, oracles, ctx.blockNumber);
    const vaults = state.vaults?.items ?? [];
    const [vaultTotals, factoryChecks] = await Promise.all([
      readVaultTotals(ctx.reader, vaults.map((v) => v.address), ctx.blockNumber),
      ctx.reader.multicall(vaults.map((v) => ({ address: VAULT_V2_FACTORY, abi: factoryAbi, functionName: "isVaultV2", args: [v.address] })), { blockNumber: ctx.blockNumber }),
    ]);
    timingsMs.onchain = ms(t);

    // ---- prices for canonical assets involved (Phase 1 Price Service only) ----
    t = performance.now();
    const involved = new Set<string>();
    for (const id of ids) {
      const p = paramsOf(id)?.params;
      if (p) [p.loanToken, p.collateralToken].forEach((a) => involved.add(assetKey(ctx.chainId, a)));
    }
    for (const v of vaults) involved.add(assetKey(ctx.chainId, v.asset.address));
    const canonicalAssets = ctx.registry.canonical().filter((a) => involved.has(a.key));
    const stocks = canonicalAssets.filter((a) => a.type === "STOCK_TOKEN");
    const mults = await ctx.reader.multicall(stocks.map((a) => ({ address: a.address!, abi: stockTokenAbi, functionName: "uiMultiplier" })), { blockNumber: ctx.blockNumber });
    const multiplierByKey = new Map<string, bigint>();
    stocks.forEach((a, i) => {
      const r = mults[i];
      if (r?.status === "success" && (r.result as bigint) > 0n) multiplierByKey.set(a.key, r.result as bigint);
    });
    const src: DataSource = { type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, method: "uiMultiplier()", blockNumber: ctx.blockNumber, observedAt: generatedAt };
    const requests: PriceRequest[] = canonicalAssets.map((asset) => {
      const m = multiplierByKey.get(asset.key);
      return { asset, ...(m ? { multiplier: { valueE18: m, source: "ONCHAIN" as const, provenance: { ...src, contract: asset.address! } } } : {}) };
    });
    const priced = requests.length ? await ctx.prices.priceAssets(requests, { blockNumber: ctx.blockNumber }) : null;
    timingsMs.prices = ms(t);
    const priceOf = (key: string): PricedAsset => {
      const q = priced?.quotes.get(key);
      return { price: q?.status === "PRICED" ? q.priceUsd : null, isChainlink: q?.method === "CHAINLINK_STOCK_TOKEN_FEED" || q?.method === "CHAINLINK_USDG_USD" || q?.method === "CHAINLINK_ETH_USD", multiplier: multiplierByKey.get(key) ?? null };
    };
    const resolveAsset = (address: Address, reportedSymbol: string, reportedDecimals: number): AssetRef => {
      const a = ctx.registry.get(ctx.chainId, address);
      if (a && a.canonical) return { key: a.key, chainId: ctx.chainId, address, symbol: a.symbol, decimals: a.decimals, canonical: true, registryType: a.type };
      return { key: assetKey(ctx.chainId, address), chainId: ctx.chainId, address, symbol: sanitizeLabel(reportedSymbol, 16) || "?", decimals: reportedDecimals, canonical: false, registryType: null };
    };
    const normalizeCtx: NormalizeContext = {
      chainId: ctx.chainId,
      blockNumber: ctx.blockNumber,
      blockTimestamp: ctx.blockTimestamp,
      nowS,
      generatedAt,
      apiFetchedAt: state.markets.fetchedAt || generatedAt,
      resolveAsset,
      priceOf,
      isLookalike: (ref) => !ref.canonical && ctx.registry.canonicalBySymbol(ref.symbol).length > 0,
    };

    // ---- normalize, isolating each market ----
    t = performance.now();
    const opportunities: Opportunity[] = [];
    const marketCtx: Snapshot["markets"] = new Map();
    let failedMarkets = 0;
    for (const [id, api] of byId) {
      try {
        const c = chain.get(id);
        const cfg = paramsOf(id) ?? (c?.params ? { params: c.params, block: { number: ctx.blockNumber, timestamp: ctx.blockTimestamp } } : null);
        const r = normalizeMarket(
          {
            api,
            params: cfg?.params ?? null,
            paramsBlock: cfg?.block ?? null,
            paramsError: c?.paramsError ?? (cfg ? null : "not read"),
            totals: c?.totals ?? null,
            totalsError: c?.totalsError ?? null,
            oraclePrice: cfg ? (oraclePrices.get(cfg.params.oracle.toLowerCase()) ?? null) : null,
          },
          normalizeCtx,
        );
        opportunities.push(...r.opportunities);
        if (!r.opportunities.length) warnings.push(...r.warnings); // skipped markets report once; published ones carry theirs
        if (cfg) marketCtx.set(id, { api, params: cfg.params, totals: c?.totals ?? null, oraclePrice: oraclePrices.get(cfg.params.oracle.toLowerCase()) ?? null });
        if (c?.totalsError) issues.push({ scope: `market ${id.slice(0, 10)}…`, message: `totals unreadable: ${c.totalsError}`, severity: "DEGRADED" });
      } catch (e) {
        failedMarkets++;
        issues.push({ scope: `market ${id.slice(0, 10)}…`, message: (e as Error).message, severity: "FATAL" });
      }
    }
    const officialVaults: ApiVault[] = [];
    vaults.forEach((v, i) => {
      try {
        const f = factoryChecks[i];
        const r = normalizeVault({ api: v, isOfficialVault: f?.status === "success" ? (f.result as boolean) : null, totalAssets: vaultTotals.get(v.address.toLowerCase()) ?? null }, normalizeCtx);
        if (r.opportunity) {
          opportunities.push(r.opportunity);
          officialVaults.push(v);
        } else warnings.push(...r.warnings);
      } catch (e) {
        issues.push({ scope: `vault ${v.address.slice(0, 10)}…`, message: (e as Error).message, severity: "FATAL" });
      }
    });
    timingsMs.normalize = ms(t);
    warnings.push(warn("REWARDS_MAY_BE_INCOMPLETE", "Morpho API reward fields can miss external campaigns (Phase 0: Merkl campaigns absent from the API); REWARD_APY covers API-reported rewards only"));
    const status: ResultStatus = byId.size === 0 && vaults.length === 0 ? "UNKNOWN" : issues.length || failedMarkets ? "PARTIAL" : "COMPLETE";
    // Positions are only scanned in factory-verified vaults.
    return { opportunities, warnings, issues, status, timingsMs, markets: marketCtx, vaults: officialVaults, normalizeCtx };
  }

  async getOpportunities(ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>> {
    const s = await this.snapshot(ctx);
    return { data: s.opportunities, status: s.status, issues: s.issues, warnings: s.warnings, timingsMs: s.timingsMs };
  }

  async getOpportunity(id: string, ctx: AdapterContext): Promise<AdapterResult<Opportunity | null>> {
    const s = await this.snapshot(ctx);
    return { data: s.opportunities.find((o) => o.id === id.toLowerCase() || o.id === id) ?? null, status: s.status, issues: s.issues, warnings: [], timingsMs: s.timingsMs };
  }

  /**
   * Positions are discovered ONCHAIN: position(id, user) over every known market and
   * balanceOf(user) over every official vault. The wallet address is not sent to the Morpho API.
   */
  async getUserPositions(wallet: Address, ctx: AdapterContext): Promise<AdapterResult<Position[]>> {
    const s = await this.snapshot(ctx);
    let t = performance.now();
    const ids = [...s.markets.keys()];
    const [{ positions, unreadable }, vaultShares] = await Promise.all([readPositions(ctx.reader, ids, wallet, ctx.blockNumber), readVaultShares(ctx.reader, s.vaults.map((v) => v.address), wallet, ctx.blockNumber)]);
    const timingsMs: Record<string, number> = { ...s.timingsMs, positions: ms(t) };
    const issues: AdapterIssue[] = [...s.issues];
    if (unreadable.length) issues.push({ scope: "positions", message: `${unreadable.length} market positions unreadable`, severity: "DEGRADED" });
    if (vaultShares.unreadable.length) issues.push({ scope: "positions", message: `${vaultShares.unreadable.length} vault balances unreadable`, severity: "DEGRADED" });
    const n = s.normalizeCtx;
    const blockFresh = classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), n.nowS);
    const obs = new Date(Number(ctx.blockTimestamp) * 1000).toISOString();
    const chainSrc = (method: string, contract: Address = MORPHO_ADDRESS): DataSource => ({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: ctx.blockNumber, observedAt: n.generatedAt });
    const measure = <T>(value: T, source: DataSource, origin: "SUPPLIED" | "COMPUTED" = "SUPPLIED", formula?: string) => ({ value, origin, source, observedAt: obs, freshness: blockFresh, verification: "VERIFIED_ONCHAIN" as const, ...(formula ? { formula } : {}) });
    const withUsd = (ref: AssetRef, raw: bigint) => {
      const p = n.priceOf(ref.key).price;
      const usd = p ? usdValueE18(raw, ref.decimals, p.raw, p.decimals) : null;
      return { asset: ref, amount: { raw, decimals: ref.decimals, display: formatFixed(raw, ref.decimals) }, usd: usd === null ? null : { e18: usd, display: formatFixed(usd, USD_DECIMALS) } };
    };

    const out: Position[] = [];
    t = performance.now();
    for (const pos of positions) {
      const m = s.markets.get(pos.id);
      if (!m) continue;
      const loan = n.resolveAsset(m.params.loanToken, m.api.loanAsset.symbol, m.api.loanAsset.decimals);
      const coll = n.resolveAsset(m.params.collateralToken, m.api.collateralAsset?.symbol ?? "?", m.api.collateralAsset?.decimals ?? 18);
      const warnings: Warning[] = [];
      if (!m.totals) warnings.push(warn("POSITION_UNVERIFIED", `market ${pos.id.slice(0, 10)}…: totals unreadable; share amounts not converted`));
      // Morpho SharesMathLib: supply rounds down, debt rounds up (in the protocol's favour).
      const supplied = m.totals && pos.supplyShares > 0n ? toAssetsDown(pos.supplyShares, m.totals.totalSupplyAssets, m.totals.totalSupplyShares) : pos.supplyShares > 0n ? null : 0n;
      const borrowed = m.totals && pos.borrowShares > 0n ? toAssetsUp(pos.borrowShares, m.totals.totalBorrowAssets, m.totals.totalBorrowShares) : pos.borrowShares > 0n ? null : 0n;
      let hf = null as Position["healthFactor"];
      let ltv = null as Position["ltv"];
      let liquidatable: boolean | null = null;
      if (borrowed !== null && m.oraclePrice !== null) {
        const maxBorrow = maxBorrowAssets(pos.collateral, m.oraclePrice, m.params.lltv);
        liquidatable = borrowed > maxBorrow;
        if (borrowed > 0n) {
          const collValueLoan = mulDivDown(pos.collateral, m.oraclePrice, ORACLE_PRICE_SCALE);
          // Morpho docs definition: HF = collateralValueInLoanToken × LLTV / borrowed
          hf = measure(mulDivDown(collValueLoan, m.params.lltv, borrowed), chainSrc("position/market/oracle.price"), "COMPUTED", "collateral × oraclePrice / 1e36 × LLTV / borrowed (Morpho health factor definition)");
          const l = ratio18(borrowed, collValueLoan);
          if (l !== null) ltv = measure(l, chainSrc("position/market/oracle.price"), "COMPUTED", "borrowed / (collateral × oraclePrice / 1e36) — application-derived");
        }
      }
      const marketOpp = (c: string) => `${ctx.chainId}:${PROTOCOL.id}:${c}:market:${pos.id}`;
      out.push({
        id: `${ctx.chainId}:${PROTOCOL.id}:position:market:${pos.id}`,
        chainId: ctx.chainId,
        protocol: { ...PROTOCOL },
        kind: "LENDING_MARKET",
        venue: { kind: "MORPHO_MARKET", id: pos.id, address: MORPHO_ADDRESS },
        relatedOpportunityIds: [...(pos.supplyShares > 0n ? [marketOpp("LEND")] : []), ...(pos.collateral > 0n || pos.borrowShares > 0n ? [marketOpp("COLLATERAL")] : [])],
        assets: [loan, coll],
        supplied: pos.supplyShares > 0n && supplied !== null ? measure(withUsd(loan, supplied), chainSrc("position.supplyShares → toAssetsDown"), "COMPUTED", "supplyShares × (totalSupplyAssets + 1) / (totalSupplyShares + 1e6)") : null,
        borrowed: pos.borrowShares > 0n && borrowed !== null ? measure(withUsd(loan, borrowed), chainSrc("position.borrowShares → toAssetsUp"), "COMPUTED", "ceil(borrowShares × (totalBorrowAssets + 1) / (totalBorrowShares + 1e6))") : null,
        collateral: pos.collateral > 0n ? measure(withUsd(coll, pos.collateral), chainSrc("position.collateral")) : null,
        shares: null,
        healthFactor: hf,
        ltv,
        liquidatable,
        provenance: [chainSrc("position(id, user)"), chainSrc("market(id)"), chainSrc("price()", m.params.oracle)],
        conflicts: [],
        warnings,
        freshness: blockFresh,
        verificationStatus: weakestStatus([loan.canonical ? "VERIFIED_ONCHAIN" : "UNVERIFIED", coll.canonical ? "VERIFIED_ONCHAIN" : "UNVERIFIED"]),
      });
    }
    for (const v of s.vaults) {
      const h = vaultShares.held.get(v.address.toLowerCase());
      if (!h) continue;
      const asset = n.resolveAsset(v.asset.address, v.asset.symbol, v.asset.decimals);
      out.push({
        id: `${ctx.chainId}:${PROTOCOL.id}:position:vault-v2:${v.address.toLowerCase()}`,
        chainId: ctx.chainId,
        protocol: { ...PROTOCOL },
        kind: "VAULT",
        venue: { kind: "MORPHO_VAULT_V2", id: v.address.toLowerCase(), address: v.address },
        relatedOpportunityIds: [`${ctx.chainId}:${PROTOCOL.id}:VAULT:vault-v2:${v.address.toLowerCase()}`],
        assets: [asset],
        supplied: h.assets !== null ? measure(withUsd(asset, h.assets), chainSrc("convertToAssets(shares)", v.address)) : null,
        borrowed: null,
        collateral: null,
        shares: measure(h.shares, chainSrc("balanceOf(user)", v.address)),
        healthFactor: null,
        ltv: null,
        liquidatable: null,
        provenance: [chainSrc("balanceOf(user)", v.address), chainSrc("convertToAssets(shares)", v.address)],
        conflicts: [],
        warnings: h.assets === null ? [warn("POSITION_UNVERIFIED", `vault ${v.address.slice(0, 10)}…: convertToAssets unreadable`)] : [],
        freshness: blockFresh,
        verificationStatus: asset.canonical ? "VERIFIED_ONCHAIN" : "UNVERIFIED",
      });
    }
    timingsMs.normalizePositions = ms(t);
    return { data: out, status: unreadable.length || vaultShares.unreadable.length ? "PARTIAL" : s.status, issues, warnings: [], timingsMs };
  }
}
