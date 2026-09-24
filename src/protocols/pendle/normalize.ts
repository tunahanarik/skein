/**
 * Pure normalization: one Pendle market (onchain identity + onchain state + Pendle API + prices)
 * → canonical Opportunities. No I/O, so every rule is unit-testable.
 *
 * Per market, three opportunities (docs/pendle-semantics.md):
 *   FIXED_YIELD  buy PT: fixed yield to maturity at the market-implied rate (not guaranteed:
 *                entry price, fees and slippage decide the realised return; PT pays in SY)
 *   YIELD        buy YT: exposure to the underlying yield until maturity; value → 0 at maturity
 *   LP           provide PT + SY liquidity: composite return, pool-composition dependent
 *
 * Source policy:
 *   identity (PT/YT/SY/expiry, token links, factory checks)  onchain — API compared
 *   implied APY                                              onchain lastLnImpliedRate — API compared
 *   pool size (PT, SY), SY rate, PT/YT/LP→asset rates        onchain at the pinned block
 *   underlying APY, YT APY, LP APY + components, listing      Pendle API (protocol-supplied)
 *   USD values                                               Phase 1 Price Service, never Pendle prices
 */
import type { Address } from "viem";
import { classifyFreshness, PROTOCOL_LIQUIDITY_CONFLICT_PCT, PROTOCOL_RATE_CONFLICT_PCT, type FreshnessInfo } from "../../config/freshness.js";
import { fixed18FromNumber, mulDivDown, WAD, type Fixed18 } from "../../lib/fixed.js";
import { formatFixed, usdValueE18, USD_DECIMALS } from "../../lib/units.js";
import { sameAddress } from "../../lib/validation.js";
import { resolveToCanonical, type AssetRelationship } from "../../model/assetRelationship.js";
import {
  opportunityId,
  type AmountWithUsd,
  type AssetRef,
  type DataConflict,
  type EntryBlocker,
  type EntryRequirement,
  type EntryStep,
  type Known,
  type Measured,
  type Opportunity,
  type OpportunityCategory,
  type OpportunityDetails,
  type OpportunityRisk,
  type YieldMetric,
} from "../../model/opportunity.js";
import type { DataSource } from "../../model/provenance.js";
import { weakestStatus, type VerificationStatus } from "../../model/verification.js";
import { warn, type Warning } from "../../model/warnings.js";
import type { AssetPrice } from "../../opportunities/assetPricing.js";
import { worstFreshness } from "../../opportunities/adapter.js";
import { maturityLifecycle } from "../../opportunities/lifecycle.js";
import { sanitizeLabel } from "../../registry/robinhoodRegistry.js";
import { sanitizeSymbol } from "../../lib/sanitize.js";
import type { PendleApiResult } from "./api.js";
import { PENDLE_CONTRACTS, PENDLE_DEPLOYMENT_SOURCE, PENDLE_DOCS } from "./constants.js";
import { differsByMoreThanPct, impliedApyFromLnRate } from "./math.js";
import type { DiscoveredMarket, MarketIdentity, MarketState, TokenMeta } from "./onchain.js";

export const PROTOCOL = { id: "pendle", name: "Pendle" } as const;
export const VENUE_KIND = "pendle-market";

export interface PendleNormalizeContext {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  nowS: number;
  generatedAt: string;
  resolveAsset: (address: Address, reportedSymbol: string | null, reportedDecimals: number | null) => AssetRef;
  priceOf: (assetKey: string) => AssetPrice;
  isLookalike: (ref: AssetRef) => boolean;
}

export interface PendleMarketInput {
  discovered: DiscoveredMarket;
  identity: MarketIdentity;
  identityBlock: { number: bigint; timestamp: bigint };
  state: MarketState | null;
  api: PendleApiResult | null;
  apiError: string | null;
  /** True when the API state is a last-good copy served after a failed refresh. */
  apiStale: boolean;
  /** True when the API was deliberately not queried (expired market). */
  apiSkipped?: boolean;
  /** True when the API answered 404 for this market: it is not indexed (not listed) by Pendle. */
  apiNotIndexed?: boolean;
}

export interface PendleNormalizeResult {
  opportunities: Opportunity[];
  warnings: Warning[];
  skipped: string | null;
}

const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString();
const known = <T>(value: T, source: DataSource): Known<T> => ({ known: true, value, source });
const unknown = (reason: string): Known<never> => ({ known: false, reason });

function amountWithUsd(ref: AssetRef, raw: bigint, p: AssetPrice): AmountWithUsd {
  const usd = p.price ? usdValueE18(raw, ref.decimals, p.price.raw, p.price.decimals) : null;
  return { asset: ref, amount: { raw, decimals: ref.decimals, display: formatFixed(raw, ref.decimals) }, usd: usd === null ? null : { e18: usd, display: formatFixed(usd, USD_DECIMALS) } };
}

/** Protocol-issued token (PT/YT/SY/LP): never canonical; symbol from chain, sanitized. */
function protocolToken(chainId: number, meta: TokenMeta, fallback: string): AssetRef {
  return {
    key: `${chainId}:${meta.address.toLowerCase()}`,
    chainId,
    address: meta.address,
    symbol: sanitizeSymbol(meta.symbol) || fallback,
    decimals: meta.decimals ?? 18,
    canonical: false,
    registryType: null,
  };
}

export function normalizePendleMarket(input: PendleMarketInput, ctx: PendleNormalizeContext): PendleNormalizeResult {
  const id = input.identity;
  const m = id.market;
  const short = `${m.slice(0, 10)}…`;
  const warnings: Warning[] = [];

  // ---- minimum identity needed to describe the market at all ----
  const missing = [id.expiry === null && "expiry", id.pt_.decimals === null && "PT decimals", id.sy_.decimals === null && "SY decimals", !id.yieldToken && "SY.yieldToken"].filter(Boolean);
  if (missing.length) {
    return { opportunities: [], warnings: [warn("MARKET_UNVERIFIED_ONCHAIN", `Pendle market ${short}: unreadable ${missing.join(", ")}; not published`)], skipped: "identity unreadable" };
  }
  const expiry = id.expiry!;
  const identityOk = id.checks.every((c) => c.ok === true);
  const failed = id.checks.filter((c) => c.ok !== true);
  if (!identityOk) warnings.push(warn("MARKET_UNVERIFIED_ONCHAIN", `Pendle market ${short}: identity checks not passed: ${failed.map((c) => `${c.check} (${c.ok === null ? "unreadable" : "false"})`).join("; ")}`));

  // ---- sources ----
  const chainSrc = (method: string, contract: Address, block = ctx.blockNumber): DataSource => ({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: block, observedAt: ctx.generatedAt });
  const identitySrc = (method: string, contract: Address) => chainSrc(method, contract, id.readAtBlock);
  const discoverySrc: DataSource = { ...chainSrc("CreateNewMarket event", PENDLE_CONTRACTS.marketFactoryV6, input.discovered.createdAtBlock) };
  const api = input.api?.market ?? null;
  const apiTsS = api?.dataUpdatedAt ? Math.floor(Date.parse(api.dataUpdatedAt) / 1000) : null;
  const apiSrc = (field: string): DataSource => ({
    type: "OFFICIAL_API",
    provider: "pendle-api",
    url: input.api!.url,
    chainId: ctx.chainId,
    method: `markets/{address}.${field}`,
    observedAt: input.api!.fetchedAt,
    ...(api?.dataUpdatedAt && Number.isFinite(apiTsS) ? { sourceTimestamp: api.dataUpdatedAt } : {}),
  });
  const blockFresh = classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), ctx.nowS);
  const configFresh = classifyFreshness("PROTOCOL_MARKET_CONFIG", Number(input.identityBlock.timestamp), ctx.nowS);
  const apiFresh: FreshnessInfo = classifyFreshness("PROTOCOL_API_MARKET_STATE", apiTsS !== null && Number.isFinite(apiTsS) ? apiTsS : null, ctx.nowS);
  if (input.apiNotIndexed) warnings.push(warn("UNLISTED_MARKET", `Pendle market ${short}: not indexed by the Pendle API (HTTP 404); discovered onchain, only onchain figures published`));
  else if (!api && !input.apiSkipped) warnings.push(warn("STALE_PROTOCOL_DATA", `Pendle market ${short}: Pendle API unavailable (${input.apiError ?? "no data"}); only onchain figures published`));
  else if (api && (input.apiStale || apiFresh.status === "STALE" || apiFresh.status === "UNKNOWN")) warnings.push(warn("STALE_PROTOCOL_DATA", `Pendle market ${short}: API state ${input.apiStale ? "served from cache after a failed refresh" : apiFresh.status} (age ${apiFresh.ageSeconds ?? "?"}s)`));
  const measured = <T>(value: T, origin: Measured<T>["origin"], source: DataSource, freshness: FreshnessInfo, verification: VerificationStatus, formula?: string): Measured<T> => ({
    value,
    origin,
    source,
    observedAt: source.sourceTimestamp ?? (source.blockNumber !== undefined ? iso(ctx.blockTimestamp) : source.observedAt),
    freshness,
    verification,
    ...(formula ? { formula } : {}),
  });

  // ---- assets (joined by address; symbols display-only) ----
  const yieldToken = ctx.resolveAsset(id.yieldToken!.address, id.yieldToken!.symbol, id.yieldToken!.decimals);
  const tokensIn = id.tokensIn.map((t) => ctx.resolveAsset(t.address, t.symbol, t.decimals));
  const accountingAsset = id.accounting?.asset ? ctx.resolveAsset(id.accounting.asset.address, id.accounting.asset.symbol, id.accounting.decimals) : null;
  const pt = protocolToken(ctx.chainId, id.pt_, "PT");
  const yt = protocolToken(ctx.chainId, id.yt_, "YT");
  const sy = protocolToken(ctx.chainId, id.sy_, "SY");
  const lp: AssetRef = { key: `${ctx.chainId}:${m.toLowerCase()}`, chainId: ctx.chainId, address: m, symbol: `LP-${pt.symbol.replace(/^PT-/, "")}`, decimals: id.lpDecimals ?? 18, canonical: false, registryType: null };
  const rewardTokens = id.rewardTokens.map((a) => ctx.resolveAsset(a, sameAddress(a, PENDLE_CONTRACTS.PENDLE) ? "PENDLE" : null, 18));
  for (const ref of [yieldToken, ...tokensIn]) {
    if (!ref.canonical) warnings.push(warn(ctx.isLookalike(ref) ? "LOOKALIKE_TOKEN" : "NON_CANONICAL_ASSET", `Pendle market ${short}: ${ref.symbol} ${ref.address} is not in the canonical registry${ctx.isLookalike(ref) ? " but uses a canonical symbol" : ""}`, { assetKey: ref.key }));
  }

  // ---- API identity cross-check (onchain is authoritative) ----
  const conflicts: DataConflict[] = [];
  if (api) {
    const cmp = (field: string, apiVal: string, chainVal: string, src: DataSource) => {
      if (apiVal.toLowerCase() !== chainVal.toLowerCase()) conflicts.push({ field, values: [{ value: apiVal, source: apiSrc(field) }, { value: chainVal, source: src }], resolution: "onchain value used; market identity disputed" });
    };
    cmp("pt", api.pt.address, id.pt, identitySrc("readTokens()", m));
    cmp("yt", api.yt.address, id.yt, identitySrc("readTokens()", m));
    cmp("sy", api.sy.address, id.sy, identitySrc("readTokens()", m));
    const apiExpiry = Math.floor(Date.parse(api.expiry) / 1000);
    cmp("expiry", Number.isFinite(apiExpiry) ? String(apiExpiry) : api.expiry, expiry.toString(), identitySrc("expiry()", m));
  }
  const identityConflict = conflicts.length > 0;

  // ---- relationships (generic model) ----
  const relVer = (ok: boolean): VerificationStatus => (ok ? "VERIFIED_ONCHAIN" : "UNVERIFIED");
  const chk = (name: string) => id.checks.find((c) => c.check === name)?.ok === true;
  const assetType = id.accounting?.type ?? "UNKNOWN";
  const multiplier = ctx.priceOf(yieldToken.key).multiplier;
  const st = input.state;
  const syRate = st?.syExchangeRate ?? null;
  const syRateEqualsMultiplier = multiplier !== null && syRate !== null ? syRate === multiplier : null;
  const unitDescription =
    assetType === "TOKEN"
      ? `${accountingAsset?.symbol ?? "?"} token units`
      : assetType === "LIQUIDITY"
        ? syRateEqualsMultiplier
          ? `not token units: SY.exchangeRate() equals ${yieldToken.symbol} uiMultiplier, so one accounting unit is one underlying share (1 token = uiMultiplier shares)`
          : `not token units (SY asset type LIQUIDITY); unit of ${accountingAsset?.symbol ?? "?"}${api?.extendedInfo?.pyUnit ? ` — Pendle API pyUnit "${sanitizeLabel(api.extendedInfo.pyUnit, 40)}"` : ""}`
        : "unknown (SY.assetInfo() unreadable)";
  if (assetType !== "TOKEN") warnings.push(warn("ACCOUNTING_UNIT_NOT_TOKEN", `Pendle market ${short}: PT redeems and implied yield accrues in accounting units — ${unitDescription}`));

  const relationships: AssetRelationship[] = [
    { kind: "WRAPS", from: sy, to: yieldToken, terms: st?.yieldTokenPerSy != null ? `SY.previewRedeem(yieldToken, 1 SY) = ${formatFixed(st.yieldTokenPerSy, yieldToken.decimals)} ${yieldToken.symbol}` : "SY.yieldToken()", source: identitySrc("yieldToken()", id.sy), verification: "VERIFIED_ONCHAIN" },
    { kind: "PRINCIPAL_COMPONENT_OF", from: pt, to: sy, terms: "minting splits SY into PT + YT, SY × index units of each (index = max(SY.exchangeRate, previous index))", source: identitySrc("PT.SY()", id.pt), verification: relVer(chk("PT.SY() == market SY") && chk("yieldContractFactory.isPT(PT)")) },
    { kind: "YIELD_COMPONENT_OF", from: yt, to: sy, terms: "receives the SY's yield until maturity; worth 0 at maturity", source: identitySrc("YT.SY()", id.yt), verification: relVer(chk("YT.SY() == market SY") && chk("yieldContractFactory.isYT(YT)")) },
    ...(accountingAsset
      ? [{ kind: "REPRESENTS_CLAIM_ON" as const, from: pt, to: accountingAsset, terms: `1 PT redeems for 1 accounting unit (${unitDescription}) at or after ${iso(expiry)}, paid in SY; if the SY exchange rate falls below its recorded index (watermark), PT redeems for less`, source: identitySrc("SY.assetInfo()", id.sy), verification: relVer(chk("PT.SY() == market SY")) }]
      : []),
    { kind: "LP_SHARE_OF", from: lp, to: pt, terms: "LP holds PT and SY in the AMM", source: identitySrc("readTokens()", m), verification: relVer(identityOk) },
    { kind: "LP_SHARE_OF", from: lp, to: sy, terms: "LP holds PT and SY in the AMM", source: identitySrc("readTokens()", m), verification: relVer(identityOk) },
  ];
  const resolved = resolveToCanonical(pt, relationships);

  // ---- lifecycle ----
  const blockers: EntryBlocker[] = [];
  if (st?.syPaused === true) {
    blockers.push("PROTOCOL_PAUSED");
    warnings.push(warn("PROTOCOL_PAUSED", `Pendle market ${short}: SY ${id.sy} is paused`));
  }
  const lifecycle = maturityLifecycle(expiry, identitySrc("expiry()", m), { number: ctx.blockNumber, timestamp: ctx.blockTimestamp }, ctx.nowS, blockers);
  const expired = lifecycle.state === "EXPIRED";
  if (st?.isExpired !== null && st?.isExpired !== undefined && st.isExpired !== expired) {
    conflicts.push({ field: "isExpired", values: [{ value: String(st.isExpired), source: chainSrc("isExpired()", m) }, { value: String(expired), source: { type: "DERIVED", provider: "defi-router", method: "expiry() <= block.timestamp", observedAt: ctx.generatedAt } }], resolution: "market's own isExpired() used for lifecycle notes; expiry vs block timestamp shown" });
  }
  if (expired) warnings.push(warn("EXPIRED_MARKET", `Pendle market ${short}: matured ${iso(expiry)}; PT is redeemable, new positions cannot be opened`));
  if (api && api.isActive === false && !expired) warnings.push(warn("PROTOCOL_WARNING", `Pendle market ${short}: Pendle API marks the market inactive`, { details: { type: "isActive", level: "false" } }));

  // ---- pool value, onchain (PT and SY decimals are checked equal) ----
  const stateSrc = chainSrc("_storage() / RouterStatic.getPtToAssetRate / SY.exchangeRate / SY.previewRedeem", m);
  const ytPrice = ctx.priceOf(yieldToken.key);
  let poolTokenRaw: bigint | null = null;
  if (st && st.totalPt !== null && st.totalSy !== null && st.totalPt >= 0n && st.totalSy >= 0n && st.ptToAssetRate !== null && syRate && syRate > 0n && st.yieldTokenPerSy !== null && chk("PT/SY decimals equal")) {
    const syEquiv = st.totalSy + mulDivDown(st.totalPt, st.ptToAssetRate, syRate);
    poolTokenRaw = mulDivDown(syEquiv, st.yieldTokenPerSy, 10n ** BigInt(id.sy_.decimals!));
  }
  const poolFormula = "(totalSy + totalPt × ptToAssetRate / SY.exchangeRate) × SY.previewRedeem(yieldToken, 1 SY); USD via Price Service";
  const pool = poolTokenRaw === null ? null : measured(amountWithUsd(yieldToken, poolTokenRaw, ytPrice), "COMPUTED", stateSrc, blockFresh, "VERIFIED_ONCHAIN", poolFormula);
  if (pool && poolTokenRaw === 0n) warnings.push(warn("ZERO_LIQUIDITY", `Pendle market ${short}: the AMM holds no PT or SY`));
  if (yieldToken.canonical && !ytPrice.price) warnings.push(warn("UNPRICED_METRIC", `Pendle market ${short}: ${yieldToken.symbol} unpriced; USD figures unavailable`, { assetKey: yieldToken.key }));
  const apiLiqUsd = api?.liquidity?.usd ?? null;
  const apiLiquidity = apiLiqUsd === null ? null : measured({ e18: fixed18FromNumber(apiLiqUsd), display: apiLiqUsd.toFixed(2) }, "SUPPLIED", apiSrc("liquidity.usd"), apiFresh, "VERIFIED_OFFICIAL_API");
  if (apiLiquidity && pool?.value.usd && differsByMoreThanPct(apiLiquidity.value.e18, pool.value.usd.e18, PROTOCOL_LIQUIDITY_CONFLICT_PCT)) {
    conflicts.push({ field: "poolLiquidityUsd", values: [{ value: apiLiquidity.value.display, source: apiLiquidity.source }, { value: pool.value.usd.display, source: stateSrc }], resolution: `onchain pool value used (API prices and index time differ; > ${PROTOCOL_LIQUIDITY_CONFLICT_PCT}% apart)` });
  }

  // ---- implied APY: onchain, cross-checked with the API ----
  const onchainImplied = st?.lastLnImpliedRate != null && !expired ? impliedApyFromLnRate(st.lastLnImpliedRate) : null;
  const apiImpliedV = api?.impliedApy ?? null;
  const apiImplied = apiImpliedV === null ? null : measured(fixed18FromNumber(apiImpliedV), "SUPPLIED", apiSrc("impliedApy"), apiFresh, "VERIFIED_OFFICIAL_API");
  if (onchainImplied !== null && apiImplied && differsByMoreThanPct(onchainImplied, apiImplied.value, PROTOCOL_RATE_CONFLICT_PCT)) {
    conflicts.push({ field: "impliedApy", values: [{ value: apiImplied.value.toString(), source: apiImplied.source }, { value: onchainImplied.toString(), source: chainSrc("_storage().lastLnImpliedRate", m) }], resolution: `onchain value used (a trade after the API index time explains a gap; > ${PROTOCOL_RATE_CONFLICT_PCT}% relative)` });
  }
  for (const c of conflicts) warnings.push(warn("DATA_CONFLICT", `Pendle market ${short}: ${c.field} API=${c.values[0]!.value} chain=${c.values[1]!.value}; ${c.resolution}`));

  // ---- yields ----
  const denom = assetType === "TOKEN" ? accountingAsset : null;
  const unitLabel = assetType === "TOKEN" ? `${accountingAsset?.symbol ?? "?"}` : "accounting units, not tokens";
  const apiYield = (type: YieldMetric["type"], v: number | null, field: string, label: string, extra: Partial<YieldMetric> = {}): YieldMetric[] =>
    v === null || expired
      ? []
      : [
          {
            type,
            side: "EARN",
            basis: "VARIABLE",
            compounding: "UNKNOWN",
            window: "Pendle API snapshot",
            denominatedIn: null,
            label,
            value: fixed18FromNumber(v),
            origin: "SUPPLIED",
            source: apiSrc(field),
            observedAt: api?.dataUpdatedAt ?? input.api!.fetchedAt,
            freshness: apiFresh,
            verification: "VERIFIED_OFFICIAL_API",
            ...extra,
          },
        ];
  const impliedYield: YieldMetric[] =
    onchainImplied !== null
      ? [
          {
            type: "IMPLIED_APY",
            side: "EARN",
            basis: "IMPLIED",
            compounding: "COMPOUNDED",
            window: "rate at the market's last trade",
            denominatedIn: denom,
            label: `Pendle market-implied APY to maturity (in ${unitLabel}); not a guaranteed return`,
            value: onchainImplied,
            origin: "COMPUTED",
            source: chainSrc("_storage().lastLnImpliedRate", m),
            observedAt: iso(ctx.blockTimestamp),
            freshness: blockFresh,
            verification: "VERIFIED_ONCHAIN",
            formula: "exp(lastLnImpliedRate / 1e18) − 1 (Pendle stores ln(1 + implied APY))",
          },
        ]
      : apiYield("IMPLIED_APY", apiImpliedV, "impliedApy", `Pendle market-implied APY (API; onchain rate unreadable), in ${unitLabel}`, { basis: "IMPLIED", compounding: "COMPOUNDED", denominatedIn: denom });
  const underlying = apiYield("UNDERLYING_APY", api?.underlyingApy ?? null, "underlyingApy", "Pendle API underlying APY (reference; not earned by entering)", { denominatedIn: denom });
  const ptYields = [...impliedYield, ...underlying];
  const ytYields = [
    ...apiYield("YIELD_EXPOSURE_APY", api?.ytFloatingApy ?? null, "ytFloatingApy", "Pendle Long Yield APY: annualised YT return if the underlying APY stays at the API value (can be negative)", { basis: "VARIABLE" }),
    ...underlying,
  ];
  const pendleReward = api?.pendleApy ?? null;
  const lpYields = [
    ...apiYield("NET_APY", api?.aggregatedApy ?? null, "aggregatedApy", "Pendle LP APY: underlying yield + PT fixed yield + swap fees + PENDLE incentives (no boost)"),
    ...apiYield("COMPONENT_APY", api?.swapFeeApy ?? null, "swapFeeApy", "LP swap-fee APY", { componentOf: "NET_APY", component: "swapFee" }),
    ...apiYield("COMPONENT_APY", api?.lpRewardApy ?? null, "lpRewardApy", "LP reward APY (reward token not specified by the API)", { componentOf: "NET_APY", component: "lpReward" }),
    ...(pendleReward !== null && pendleReward > 0
      ? apiYield("REWARD_APY", pendleReward, "pendleApy", "PENDLE incentive APY (paid in PENDLE)", { rewardAsset: rewardTokens.find((r) => sameAddress(r.address, PENDLE_CONTRACTS.PENDLE)) ?? null, compounding: "SIMPLE" })
      : []),
    ...underlying,
  ];

  // ---- yield-source clarity (measured facts only) ----
  if (!expired && api) {
    const stockUnit = yieldToken.canonical && yieldToken.registryType === "STOCK_TOKEN" && syRateEqualsMultiplier === true;
    if (stockUnit && (api.underlyingApy ?? 0) === 0) {
      warnings.push(
        warn("UNDERLYING_YIELD_SOURCE_UNCLEAR", `Pendle market ${short}: SY.exchangeRate() equals ${yieldToken.symbol} uiMultiplier (grows with reinvested dividends) while the Pendle API reports underlyingApy 0 and Long Yield APY ${api.ytFloatingApy ?? "?"}; realised YT yield follows multiplier growth, which the API figure does not appear to include`, { assetKey: yieldToken.key }),
      );
    }
    const external = api.underlyingRewardApyBreakdown.filter((b) => (b.absoluteApy ?? 0) > 0);
    if (external.length) {
      warnings.push(warn("UNDERLYING_UNVERIFIED", `Pendle market ${short}: underlying APY includes ${external.map((b) => `${sanitizeLabel(b.source ?? "reward", 24)} ${((b.absoluteApy ?? 0) * 100).toFixed(2)}%`).join(", ")} reported by the Pendle API; not verifiable onchain (SY.exchangeRate does not accrue it)`));
    }
  }

  // ---- entry ----
  const primary = tokensIn.find((t) => t.key === yieldToken.key) ?? tokensIn[0] ?? null;
  const routerSrc: DataSource = { type: "OFFICIAL_DOCS", provider: "pendle-deployments", url: PENDLE_DEPLOYMENT_SOURCE, contract: PENDLE_CONTRACTS.router, method: "router", observedAt: ctx.generatedAt };
  const poolHasPt = (st?.totalPt ?? 0n) > 0n;
  const entryFor = (position: "PT" | "YT" | "LP"): EntryRequirement => {
    if (!primary) {
      return { kind: "UNKNOWN", requiredAsset: yieldToken, steps: [], singleTransactionAvailable: unknown("no verified input token"), note: "SY accepts no readable input token" };
    }
    const open = !expired && identityOk && st?.syPaused !== true;
    const wrap: EntryStep = { action: "WRAP", from: primary, to: sy, venue: `SY ${id.sy}`, verified: true, source: identitySrc("SY.getTokensIn()", id.sy) };
    const second: EntryStep =
      position === "LP"
        ? { action: "ADD_LIQUIDITY", from: sy, to: lp, venue: `Pendle market ${m}`, verified: open, source: identitySrc("factory.isValidMarket(market)", PENDLE_CONTRACTS.marketFactoryV6) }
        : { action: "SWAP", from: sy, to: position === "PT" ? pt : yt, venue: `Pendle market ${m}`, verified: open && poolHasPt, source: chainSrc("_storage().totalPt", m) };
    const routerFn = position === "PT" ? "swapExactTokenForPt" : position === "YT" ? "swapExactTokenForYt" : "addLiquiditySingleToken";
    return {
      kind: "SY_CONVERSION_REQUIRED",
      requiredAsset: primary,
      steps: [wrap, second],
      singleTransactionAvailable: known(true, { ...routerSrc, method: `PendleRouter.${routerFn} (router address from the official deployment file; documented at ${PENDLE_DOCS}; not simulated)` }),
      note: `${primary.symbol} is wrapped into ${sy.symbol}, then ${position === "LP" ? "added to the PT/SY pool" : `swapped for ${position === "PT" ? pt.symbol : yt.symbol} in the market`}. The Pendle router can do both in one call. Descriptive only — no route or calldata is built.`,
    };
  };

  if (!primary) warnings.push(warn("ENTRY_ROUTE_UNKNOWN", `Pendle market ${short}: SY.getTokensIn() is empty or unreadable; no verified entry token`));

  // ---- verification ----
  const assetStatus = (r: AssetRef): VerificationStatus => (r.canonical ? "VERIFIED_ONCHAIN" : "UNVERIFIED");
  const verificationFor = (yields: YieldMetric[]): VerificationStatus => {
    if (identityConflict) return "CONFLICT";
    if (!identityOk) return "UNVERIFIED";
    return weakestStatus([...[yieldToken, ...tokensIn].map(assetStatus), ...(st ? ["VERIFIED_ONCHAIN" as const] : ["UNVERIFIED" as const]), ...yields.map((y) => y.verification)]);
  };
  const allCanonical = yieldToken.canonical && tokensIn.every((t) => t.canonical) && resolved.canonical !== null;

  const risk = (yields: YieldMetric[], category: OpportunityCategory): OpportunityRisk => {
    const headline = yields.find((y) => y.type === "NET_APY");
    const rewards = yields.filter((y) => y.type === "REWARD_APY").reduce((s, y) => s + y.value, 0n);
    return {
      oracle: null,
      lltv: unknown("not a lending market"),
      utilization: unknown("not a lending market"),
      availableLiquidityUsd: pool?.value.usd ? known(pool.value.usd, stateSrc) : unknown(pool ? "yield token unpriced" : "pool state unreadable"),
      marketSizeUsd: pool?.value.usd ? known(pool.value.usd, stateSrc) : unknown(pool ? "yield token unpriced" : "pool state unreadable"),
      rewardDependence:
        category === "LP" && headline && headline.value > 0n ? known(mulDivDown(rewards, WAD, headline.value), headline.source) : unknown(category === "LP" ? "no positive LP headline yield" : "no reward component for this position"),
      parameterMutability: known(
        "PT, YT, SY, expiry and the AMM curve parameters (scalarRoot, initialAnchor, lnFeeRateRoot) are fixed at market creation; the SY wrapper has an owner and exposes paused(), read every run",
        discoverySrc,
      ),
      protocolListed: input.apiNotIndexed
        ? known(false, { type: "OFFICIAL_API", provider: "pendle-api", chainId: ctx.chainId, method: "markets/{address} → HTTP 404 (not indexed)", observedAt: ctx.generatedAt })
        : api?.isWhitelistedPro == null ? unknown(api ? "API did not report listing" : "Pendle API unavailable") : known(api.isWhitelistedPro, apiSrc("isWhitelistedPro")),
      protocolWarnings: [],
      allAssetsCanonical: allCanonical,
    };
  };
  if (api?.isWhitelistedPro === false) warnings.push(warn("UNLISTED_MARKET", `Pendle market ${short}: not listed in the Pendle app (isWhitelistedPro=false); discovered onchain`));

  // ---- details ----
  const rateM = (v: bigint | null | undefined, method: string, contract: Address) => (v == null ? null : measured(v, "SUPPLIED", chainSrc(method, contract), blockFresh, "VERIFIED_ONCHAIN"));
  const details: OpportunityDetails = {
    kind: "PENDLE_MARKET",
    market: m,
    position: "PT",
    pt,
    yt,
    sy,
    yieldToken,
    accountingAsset,
    accountingUnit: { assetType, description: unitDescription, syRateEqualsMultiplier },
    rewardTokens,
    identityChecks: id.checks,
    apiImpliedApy: apiImplied,
    createdAtBlock: input.discovered.createdAtBlock,
    syExchangeRate: rateM(syRate, "SY.exchangeRate()", id.sy),
    ptToAssetRate: rateM(st?.ptToAssetRate, "RouterStatic.getPtToAssetRate(market)", PENDLE_CONTRACTS.routerStatic),
    ytToAssetRate: rateM(st?.ytToAssetRate, "RouterStatic.getYtToAssetRate(market)", PENDLE_CONTRACTS.routerStatic),
    lpToAssetRate: rateM(st?.lpToAssetRate, "RouterStatic.getLpToAssetRate(market)", PENDLE_CONTRACTS.routerStatic),
    ptDiscount:
      st?.ptToAssetRate != null && st.ptToAssetRate <= WAD
        ? measured(WAD - st.ptToAssetRate, "COMPUTED", chainSrc("RouterStatic.getPtToAssetRate(market)", PENDLE_CONTRACTS.routerStatic), blockFresh, "VERIFIED_ONCHAIN", "1 − ptToAssetRate (discount to the maturity redemption value, spot, before fees/slippage)")
        : null,
    ptRoiToMaturity: api?.ptRoi == null || expired ? null : measured(fixed18FromNumber(api.ptRoi), "SUPPLIED", apiSrc("ptRoi"), apiFresh, "VERIFIED_OFFICIAL_API"),
    ytRoiToMaturity: api?.ytRoi == null || expired ? null : measured(fixed18FromNumber(api.ytRoi), "SUPPLIED", apiSrc("ytRoi"), apiFresh, "VERIFIED_OFFICIAL_API"),
    apiLiquidityUsd: apiLiquidity,
    poolTotalPt: st?.totalPt ?? null,
    poolTotalSy: st?.totalSy ?? null,
    protocolListed: api?.isWhitelistedPro ?? null,
  };

  const provenance = [discoverySrc, identitySrc("readTokens()/expiry()/checks", m), ...(st ? [stateSrc] : []), ...(api ? [apiSrc("*")] : [])];
  const make = (category: OpportunityCategory, position: "PT" | "YT" | "LP", yields: YieldMetric[], output: AssetRef, title: string, extraWarnings: Warning[]): Opportunity => {
    const entry = entryFor(position);
    return {
      id: opportunityId(ctx.chainId, PROTOCOL.id, category, VENUE_KIND, m),
      chainId: ctx.chainId,
      protocol: { ...PROTOCOL },
      category,
      title,
      venue: { kind: VENUE_KIND, id: m.toLowerCase(), address: m },
      primaryAsset: entry.requiredAsset,
      inputAssets: tokensIn,
      outputAssets: [output],
      collateralAssets: [],
      borrowAssets: [],
      yields,
      tvl: pool,
      availableLiquidity: pool,
      liquidityKind: "POOL_LIQUIDITY",
      utilization: null,
      liquidation: null,
      term: { maturity: iso(expiry), lockSeconds: null, withdrawal: "TRADE_BEFORE_MATURITY" },
      lifecycle,
      entry,
      relationships,
      eligibility: null,
      contracts: [
        { role: "market", address: m },
        { role: "sy", address: id.sy },
        { role: "pt", address: id.pt },
        { role: "yt", address: id.yt },
        { role: "router", address: PENDLE_CONTRACTS.router },
        { role: "routerStatic", address: PENDLE_CONTRACTS.routerStatic },
      ],
      risk: risk(yields, category),
      details: { ...details, position } as OpportunityDetails,
      provenance,
      conflicts,
      warnings: [...warnings, ...extraWarnings],
      freshness: worstFreshness([configFresh, ...(st ? [blockFresh] : []), ...yields.map((y) => y.freshness)], blockFresh),
      verificationStatus: verificationFor(yields),
      observedAt: iso(ctx.blockTimestamp),
      generatedAt: ctx.generatedAt,
    };
  };

  const until = iso(expiry).slice(0, 10);
  const entrySym = primary?.symbol ?? yieldToken.symbol;
  const ptNote = expired
    ? []
    : [warn("IMPLIED_RATE_NOT_GUARANTEED", `Pendle market ${short}: the implied APY is the rate at the last trade; the realised return depends on the entry price after fees and slippage, holding to maturity, and SY redemption (depeg/watermark)`)];
  const ytNote = [warn("YIELD_TOKEN_DECAYS_TO_ZERO", `Pendle market ${short}: YT receives yield only until ${until} and is worth 0 at maturity; the return depends on realised yield and can be negative`)];
  return {
    opportunities: [
      make("FIXED_YIELD", "PT", ptYields, pt, `Buy ${pt.symbol} with ${entrySym}: fixed yield to ${until} (Pendle)`, ptNote),
      make("YIELD", "YT", ytYields, yt, `Buy ${yt.symbol} with ${entrySym}: ${yieldToken.symbol} yield exposure to ${until} (Pendle)`, ytNote),
      make("LP", "LP", lpYields, lp, `Provide ${entrySym} liquidity to the Pendle ${pt.symbol.replace(/^PT-/, "")} pool (PT + SY)`, []),
    ],
    warnings,
    skipped: null,
  };
}
