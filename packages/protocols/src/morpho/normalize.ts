/**
 * Pure normalization: one Morpho market (API + onchain + prices) → canonical Opportunities.
 * No I/O here, so every rule is unit-testable.
 *
 * Opportunities created per market (only what Morpho Blue supports):
 *   LEND        primary = loan asset:       supply the loan asset, earn SUPPLY_APY
 *   COLLATERAL  primary = collateral asset: post it, borrow the loan asset, pay BORROW_APY
 * BORROW is not emitted separately: in Morpho, borrowing the loan asset requires this market's
 * collateral, so it is the same action as COLLATERAL seen from the collateral holder.
 * Skipped: markets without an IRM (no interest) or without a collateral token (idle markets).
 *
 * Source policy (docs/protocols/morpho-adapter.md):
 *   identity (loan, collateral, oracle, IRM, LLTV)  onchain idToMarketParams — API compared
 *   totals (supply, borrow, liquidity, utilization) onchain market(id) at our block — API compared
 *   APY, rewards, listed flag, warnings              Morpho API (protocol-supplied)
 *   USD values                                       our Phase 1 Price Service
 *   LIF, maximum borrow                              computed from Morpho's formulas
 */
import type { Address, Hex } from "viem";
import { classifyFreshness, PROTOCOL_TOTALS_CONFLICT_PCT, type FreshnessInfo } from "@skein/core/config/freshness";
import { fixed18FromNumber, formatFixed18, ratio18, type Fixed18 } from "@skein/core/lib/fixed";
import { formatFixed, usdValueE18, USD_DECIMALS } from "@skein/core/lib/units";
import { sameAddress, ZERO_ADDRESS } from "@skein/core/lib/validation";
import {
  opportunityId,
  type AmountWithUsd,
  type AssetRef,
  type DataConflict,
  type Known,
  type Measured,
  type Opportunity,
  type OpportunityCategory,
  type OpportunityRisk,
  type YieldMetric,
} from "@skein/core/model/opportunity";
import type { DataSource } from "@skein/core/model/provenance";
import { weakestStatus, type VerificationStatus } from "@skein/core/model/verification";
import { warn, type Warning } from "@skein/core/model/warnings";
import type { UsdPrice } from "@skein/pricing/types";
import { worstFreshness } from "@skein/engine/opportunities/adapter";
import { openEndedLifecycle } from "@skein/engine/opportunities/lifecycle";
import type { ApiMarket } from "./api.js";
import { MORPHO_API_URL } from "./api.js";
import { checkOracle } from "./oracleCheck.js";
import { liquidationIncentiveFactor, MORPHO_ADDRESS, ORACLE_PRICE_SCALE, marketIdOf, type MarketParams, type MarketTotals } from "./onchain.js";

export const PROTOCOL = { id: "morpho", name: "Morpho" } as const;

export interface PricedAsset {
  price: UsdPrice | null;
  isChainlink: boolean;
  multiplier: bigint | null;
}

export interface NormalizeContext {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  nowS: number;
  generatedAt: string;
  apiFetchedAt: string;
  resolveAsset: (address: Address, reportedSymbol: string, reportedDecimals: number) => AssetRef;
  priceOf: (assetKey: string) => PricedAsset;
  /** Lookalike detection: canonical assets that share `symbol`. */
  isLookalike: (ref: AssetRef) => boolean;
}

export interface MarketInput {
  api: ApiMarket;
  params: MarketParams | null;
  /** Block the params were read at (they are immutable, so cached reads keep their block). */
  paramsBlock: { number: bigint; timestamp: bigint } | null;
  paramsError: string | null;
  totals: MarketTotals | null;
  totalsError: string | null;
  oraclePrice: bigint | null;
}

export interface NormalizeResult {
  opportunities: Opportunity[];
  warnings: Warning[];
  skipped: string | null;
}

const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString();

function onchainSource(ctx: NormalizeContext, method: string, contract: Address, block = ctx.blockNumber): DataSource {
  return { type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: block, observedAt: ctx.generatedAt };
}

function apiSource(ctx: NormalizeContext, method: string, stateTs: bigint | null): DataSource {
  return { type: "OFFICIAL_API", provider: "morpho-api", url: MORPHO_API_URL, chainId: ctx.chainId, method, observedAt: ctx.apiFetchedAt, ...(stateTs ? { sourceTimestamp: iso(stateTs) } : {}) };
}

function amountWithUsd(ref: AssetRef, raw: bigint, p: PricedAsset): AmountWithUsd {
  const usd = p.price ? usdValueE18(raw, ref.decimals, p.price.raw, p.price.decimals) : null;
  return {
    asset: ref,
    amount: { raw, decimals: ref.decimals, display: formatFixed(raw, ref.decimals) },
    usd: usd === null ? null : { e18: usd, display: formatFixed(usd, USD_DECIMALS) },
  };
}

const known = <T>(value: T, source: DataSource): Known<T> => ({ known: true, value, source });
const unknown = (reason: string): Known<never> => ({ known: false, reason });

export function normalizeMarket(input: MarketInput, ctx: NormalizeContext): NormalizeResult {
  const { api } = input;
  const warnings: Warning[] = [];
  const id = api.marketId as Hex;
  const short = `${id.slice(0, 10)}…`;

  // ---- identity: onchain is authoritative; API differences are recorded, never silently resolved ----
  if (!input.params) {
    return { opportunities: [], warnings: [warn("MARKET_UNVERIFIED_ONCHAIN", `market ${short}: idToMarketParams unreadable (${input.paramsError}); not published`)], skipped: "identity not verifiable onchain" };
  }
  const p = input.params;
  if (sameAddress(p.loanToken, ZERO_ADDRESS)) {
    return { opportunities: [], warnings: [warn("MARKET_UNVERIFIED_ONCHAIN", `market ${short}: not created onchain (empty params)`)], skipped: "market does not exist onchain" };
  }
  const conflicts: DataConflict[] = [];
  const paramsSrc = onchainSource(ctx, "idToMarketParams(id)", MORPHO_ADDRESS, input.paramsBlock?.number ?? ctx.blockNumber);
  const apiMarketSrc = apiSource(ctx, `markets.items[${short}]`, api.state?.timestamp ?? null);
  const cmp = (field: string, apiVal: string, chainVal: string) => {
    if (apiVal.toLowerCase() !== chainVal.toLowerCase()) {
      conflicts.push({ field, values: [{ value: apiVal, source: apiMarketSrc }, { value: chainVal, source: paramsSrc }], resolution: "onchain value used" });
    }
  };
  if (marketIdOf(p).toLowerCase() !== id) conflicts.push({ field: "marketId", values: [{ value: id, source: apiMarketSrc }, { value: marketIdOf(p), source: paramsSrc }], resolution: "id does not hash from onchain params; market not trusted" });
  cmp("loanToken", api.loanAsset.address, p.loanToken);
  cmp("collateralToken", api.collateralAsset?.address ?? ZERO_ADDRESS, p.collateralToken);
  cmp("oracle", api.oracle?.address ?? ZERO_ADDRESS, p.oracle);
  cmp("irm", api.irmAddress, p.irm);
  cmp("lltv", api.lltv.toString(), p.lltv.toString());
  const identityBroken = conflicts.some((c) => c.field === "marketId");

  if (sameAddress(p.irm, ZERO_ADDRESS) || sameAddress(p.collateralToken, ZERO_ADDRESS)) {
    return { opportunities: [], warnings: [warn("MARKET_SKIPPED", `market ${short}: ${sameAddress(p.irm, ZERO_ADDRESS) ? "no IRM (pays no interest)" : "no collateral token (idle market)"}`)], skipped: "idle market" };
  }

  // Asset identity: joined by address to the Phase 1 registry (onchain addresses, API symbols for display only).
  const loan = ctx.resolveAsset(p.loanToken, sameAddress(api.loanAsset.address, p.loanToken) ? api.loanAsset.symbol : "?", api.loanAsset.decimals);
  const coll = ctx.resolveAsset(p.collateralToken, api.collateralAsset && sameAddress(api.collateralAsset.address, p.collateralToken) ? api.collateralAsset.symbol : "?", api.collateralAsset?.decimals ?? 18);
  for (const ref of [loan, coll]) {
    if (!ref.canonical) {
      warnings.push(warn(ctx.isLookalike(ref) ? "LOOKALIKE_TOKEN" : "NON_CANONICAL_ASSET", `market ${short}: ${ref.symbol} ${ref.address} is not in the canonical registry${ctx.isLookalike(ref) ? " but uses a canonical symbol" : ""}`, { assetKey: ref.key }));
    }
  }

  // ---- state ----
  const blockFresh = classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), ctx.nowS);
  const paramsFresh = classifyFreshness("PROTOCOL_MARKET_CONFIG", Number(input.paramsBlock?.timestamp ?? ctx.blockTimestamp), ctx.nowS);
  const apiTs = api.state?.timestamp ?? null;
  const apiFresh: FreshnessInfo = classifyFreshness("PROTOCOL_API_MARKET_STATE", apiTs === null ? null : Number(apiTs), ctx.nowS);
  if (apiFresh.status === "STALE" || apiFresh.status === "UNKNOWN") {
    warnings.push(warn("STALE_PROTOCOL_DATA", `market ${short}: Morpho API state ${apiFresh.status} (age ${apiFresh.ageSeconds ?? "?"}s)`));
  }
  const totalsSrc = onchainSource(ctx, "market(id)", MORPHO_ADDRESS);
  const measured = <T>(value: T, origin: Measured<T>["origin"], source: DataSource, freshness: FreshnessInfo, verification: VerificationStatus, formula?: string): Measured<T> => ({
    value,
    origin,
    source,
    observedAt: source.sourceTimestamp ?? (source.blockNumber !== undefined ? iso(ctx.blockTimestamp) : source.observedAt),
    freshness,
    verification,
    ...(formula ? { formula } : {}),
  });

  const t = input.totals;
  if (!t) warnings.push(warn("MARKET_UNVERIFIED_ONCHAIN", `market ${short}: market(id) unreadable (${input.totalsError}); totals unavailable`));
  if (t && api.state) {
    const pairs: [string, bigint | null, bigint][] = [
      ["totalSupplyAssets", api.state.supplyAssets, t.totalSupplyAssets],
      ["totalBorrowAssets", api.state.borrowAssets, t.totalBorrowAssets],
    ];
    for (const [field, a, c] of pairs) {
      if (a === null) continue;
      const base = c > a ? c : a;
      if (base > 0n && ((c > a ? c - a : a - c) * 10_000n) / base > BigInt(PROTOCOL_TOTALS_CONFLICT_PCT * 100)) {
        conflicts.push({ field, values: [{ value: a.toString(), source: { ...apiMarketSrc, method: `state.${field === "totalSupplyAssets" ? "supplyAssets" : "borrowAssets"} @ block ${api.state.blockNumber ?? "?"}` } }, { value: c.toString(), source: totalsSrc }], resolution: `onchain value used (API indexed at an earlier block; > ${PROTOCOL_TOTALS_CONFLICT_PCT}% apart)` });
      }
    }
  }

  const loanPx = ctx.priceOf(loan.key);
  const collPx = ctx.priceOf(coll.key);
  const liquidityRaw = t ? (t.totalSupplyAssets > t.totalBorrowAssets ? t.totalSupplyAssets - t.totalBorrowAssets : 0n) : null;
  const util = t ? ratio18(t.totalBorrowAssets, t.totalSupplyAssets) : null;
  const utilization = util === null ? null : measured<Fixed18>(util, "COMPUTED", totalsSrc, blockFresh, "VERIFIED_ONCHAIN", "totalBorrowAssets / totalSupplyAssets");
  const availableLiquidity = liquidityRaw === null ? null : measured(amountWithUsd(loan, liquidityRaw, loanPx), "COMPUTED", totalsSrc, blockFresh, "VERIFIED_ONCHAIN", "totalSupplyAssets − totalBorrowAssets; USD via Price Service");
  const supplyTvl = t ? measured(amountWithUsd(loan, t.totalSupplyAssets, loanPx), "SUPPLIED", totalsSrc, blockFresh, "VERIFIED_ONCHAIN") : null;
  const totalBorrow = t ? measured({ raw: t.totalBorrowAssets, decimals: loan.decimals, display: formatFixed(t.totalBorrowAssets, loan.decimals) }, "SUPPLIED", totalsSrc, blockFresh, "VERIFIED_ONCHAIN") : null;
  if (liquidityRaw === 0n) warnings.push(warn("ZERO_LIQUIDITY", `market ${short}: no available liquidity`));
  if (util !== null && util >= 10n ** 18n && t!.totalSupplyAssets > 0n) warnings.push(warn("FULL_UTILIZATION", `market ${short}: 100% utilized; suppliers cannot withdraw until repayments`));
  if (loan.canonical && !loanPx.price) warnings.push(warn("UNPRICED_METRIC", `market ${short}: ${loan.symbol} unpriced; USD figures unavailable`, { assetKey: loan.key }));

  // ---- oracle ----
  const oracleSrc = onchainSource(ctx, "price()", p.oracle);
  const oracleCheck = checkOracle({
    oraclePrice: input.oraclePrice,
    collateralDecimals: coll.decimals,
    loanDecimals: loan.decimals,
    collateralPrice: collPx.price,
    collateralPriceIsChainlink: collPx.isChainlink,
    loanPrice: loanPx.price,
    isStockTokenCollateral: coll.canonical && coll.registryType === "STOCK_TOKEN",
    multiplier: collPx.multiplier,
  });
  if (input.oraclePrice === null) warnings.push(warn("ORACLE_UNREADABLE", `market ${short}: oracle ${p.oracle} price() reverted or unreadable`));
  if (oracleCheck.multiplierCheck === "DOUBLE_APPLIED") warnings.push(warn("ORACLE_MULTIPLIER_DOUBLE_APPLIED", `market ${short}: ${oracleCheck.multiplierCheckDetail}`, { details: { oracle: p.oracle } }));
  if (oracleCheck.multiplierCheck === "DEVIATES") warnings.push(warn("ORACLE_PRICE_DEVIATION", `market ${short}: ${oracleCheck.multiplierCheckDetail}`, { details: { oracle: p.oracle } }));
  if (oracleCheck.multiplierCheck === "INCONCLUSIVE") warnings.push(warn("ORACLE_INCONCLUSIVE", `market ${short}: ${oracleCheck.multiplierCheckDetail}`, { details: { oracle: p.oracle } }));
  if (oracleCheck.loanPegAssumed) warnings.push(warn("ORACLE_ASSUMES_LOAN_PEG", `market ${short}: oracle values ${loan.symbol} at exactly $1 (depeg would not be reflected)`, { details: { oracle: p.oracle } }));
  if (api.listed === false) warnings.push(warn("UNLISTED_MARKET", `market ${short}: not listed by Morpho`));
  for (const w of api.warnings) warnings.push(warn("PROTOCOL_WARNING", `market ${short}: Morpho reports ${w.type} (${w.level})`, { details: { type: w.type, level: w.level } }));
  for (const c of conflicts) warnings.push(warn("DATA_CONFLICT", `market ${short}: ${c.field} API=${c.values[0]!.value} chain=${c.values[1]!.value}; ${c.resolution}`));

  // ---- yields (protocol-supplied floats → Fixed18 once) ----
  const y = (type: YieldMetric["type"], side: YieldMetric["side"], v: number | null, field: string, label: string, extra: Partial<YieldMetric> = {}): YieldMetric[] => {
    if (v === null) return [];
    return [
      {
        type,
        side,
        basis: "VARIABLE",
        compounding: type === "REWARD_APY" ? "SIMPLE" : "COMPOUNDED",
        window: "instant",
        denominatedIn: type === "REWARD_APY" ? null : loan,
        label,
        value: fixed18FromNumber(v),
        origin: "SUPPLIED",
        source: { ...apiMarketSrc, method: `state.${field}` },
        observedAt: apiTs ? iso(apiTs) : ctx.apiFetchedAt,
        freshness: apiFresh,
        verification: "VERIFIED_OFFICIAL_API",
        ...extra,
      },
    ];
  };
  const rewards = (side: "supply" | "borrow"): YieldMetric[] =>
    (api.state?.rewards ?? []).flatMap((r) => {
      const v = side === "supply" ? r.supplyApr : r.borrowApr;
      if (v === null || v === 0) return [];
      const reward = ctx.resolveAsset(r.asset.address, r.asset.symbol, 18);
      return y("REWARD_APY", "EARN", v, `rewards[${r.asset.symbol}].${side}Apr`, `Morpho ${side} reward APR (${reward.symbol})`, { rewardAsset: reward, compounding: "SIMPLE" });
    });

  const lltvMeasured = measured<Fixed18>(p.lltv, "SUPPLIED", paramsSrc, paramsFresh, "VERIFIED_ONCHAIN");
  const lif = liquidationIncentiveFactor(p.lltv);
  const collateralPrice = input.oraclePrice === null ? null : measured({ raw: input.oraclePrice, scale: ORACLE_PRICE_SCALE }, "SUPPLIED", oracleSrc, blockFresh, "VERIFIED_ONCHAIN");

  const assetStatus = (r: AssetRef): VerificationStatus => (r.canonical ? "VERIFIED_ONCHAIN" : "UNVERIFIED");
  const allCanonical = loan.canonical && coll.canonical;
  const baseRisk = (earn: YieldMetric[]): OpportunityRisk => {
    const rewardSum = earn.filter((m) => m.type === "REWARD_APY").reduce((s, m) => s + m.value, 0n);
    const headline = earn.find((m) => m.type === "SUPPLY_APY" || m.type === "NET_APY");
    return {
      oracle: { address: p.oracle, reportedType: api.oracle?.type ?? null, multiplierCheck: oracleCheck.multiplierCheck, multiplierCheckDetail: oracleCheck.multiplierCheckDetail, loanPegAssumed: oracleCheck.loanPegAssumed },
      lltv: known(p.lltv, paramsSrc),
      utilization: util === null ? unknown("market(id) unreadable") : known(util, totalsSrc),
      availableLiquidityUsd: availableLiquidity?.value.usd ? known(availableLiquidity.value.usd, totalsSrc) : unknown(availableLiquidity ? "loan asset unpriced" : "totals unreadable"),
      marketSizeUsd: supplyTvl?.value.usd ? known(supplyTvl.value.usd, totalsSrc) : unknown(supplyTvl ? "loan asset unpriced" : "totals unreadable"),
      rewardDependence: headline && headline.value > 0n ? known(ratio18(rewardSum, headline.value + rewardSum)!, apiMarketSrc) : unknown(earn.length ? "no positive headline yield" : "no earn yield"),
      parameterMutability: known("loan token, collateral token, oracle, IRM and LLTV are immutable for a Morpho market; the oracle contract itself may have its own admin", paramsSrc),
      protocolListed: api.listed === null ? unknown("API did not report listing") : known(api.listed, apiMarketSrc),
      protocolWarnings: api.warnings,
      allAssetsCanonical: allCanonical,
    };
  };

  const verificationFor = (yields: YieldMetric[], assets: AssetRef[]): VerificationStatus => {
    if (identityBroken || conflicts.some((c) => ["loanToken", "collateralToken", "oracle", "irm", "lltv"].includes(c.field)) || oracleCheck.multiplierCheck === "DOUBLE_APPLIED") return "CONFLICT";
    const st: VerificationStatus[] = [...assets.map(assetStatus), ...(t ? ["VERIFIED_ONCHAIN" as const] : ["UNVERIFIED" as const]), ...yields.map((m) => m.verification)];
    return weakestStatus(st);
  };

  const common = {
    chainId: ctx.chainId,
    protocol: { ...PROTOCOL },
    venue: { kind: "MORPHO_MARKET", id, address: MORPHO_ADDRESS },
    contracts: [
      { role: "morpho", address: MORPHO_ADDRESS },
      { role: "oracle", address: p.oracle },
      { role: "irm", address: p.irm },
    ],
    details: {
      kind: "MORPHO_MARKET" as const,
      marketId: id,
      loanAsset: loan,
      collateralAsset: coll,
      oracle: p.oracle,
      irm: p.irm,
      lltv: p.lltv,
      totalSupply: supplyTvl && supplyTvl.value.amount ? { ...supplyTvl, value: supplyTvl.value.amount } : null,
      totalBorrow,
      oraclePrice: input.oraclePrice === null ? null : measured(input.oraclePrice, "SUPPLIED", oracleSrc, blockFresh, "VERIFIED_ONCHAIN"),
    },
    conflicts,
    generatedAt: ctx.generatedAt,
    observedAt: iso(ctx.blockTimestamp),
  };

  const make = (category: OpportunityCategory, primary: AssetRef, yields: YieldMetric[], extra: Partial<Opportunity>, title: string): Opportunity => {
    const freshList = [paramsFresh, ...(t ? [blockFresh] : []), ...yields.map((m) => m.freshness)];
    const provenance = [paramsSrc, ...(t ? [totalsSrc] : []), apiMarketSrc, ...(input.oraclePrice !== null ? [oracleSrc] : [])];
    return {
      ...common,
      id: opportunityId(ctx.chainId, PROTOCOL.id, category, "market", id),
      category,
      title,
      primaryAsset: primary,
      inputAssets: [],
      outputAssets: [],
      collateralAssets: [],
      borrowAssets: [],
      yields,
      tvl: null,
      availableLiquidity,
      utilization,
      liquidation: null,
      term: { maturity: null, lockSeconds: null, withdrawal: "INSTANT_SUBJECT_TO_LIQUIDITY" },
      risk: baseRisk(yields.filter((m) => m.side === "EARN")),
      // Morpho Blue markets have no maturity and no supply caps: open-ended, always enterable.
      liquidityKind: category === "COLLATERAL" ? "BORROWABLE" : "WITHDRAWABLE_SUPPLY",
      lifecycle: openEndedLifecycle({ number: ctx.blockNumber, timestamp: ctx.blockTimestamp }),
      entry: {
        kind: "DIRECT",
        requiredAsset: primary,
        steps: [{ action: category === "COLLATERAL" ? "POST_COLLATERAL" : "SUPPLY", from: primary, to: null, venue: `Morpho ${MORPHO_ADDRESS}`, verified: true, source: paramsSrc }],
        singleTransactionAvailable: { known: true, value: true, source: { type: "OFFICIAL_DOCS", provider: "morpho-blue-source", url: "https://github.com/morpho-org/morpho-blue/blob/main/src/Morpho.sol", method: category === "COLLATERAL" ? "supplyCollateral()" : "supply()", observedAt: ctx.generatedAt } },
        note: null,
      },
      relationships: [],
      eligibility: null,
      provenance,
      warnings: [...warnings],
      freshness: worstFreshness(freshList, blockFresh),
      verificationStatus: verificationFor(yields, [loan, coll]),
      ...extra,
    };
  };

  const lendYields = [
    ...y("SUPPLY_APY", "EARN", api.state?.supplyApy ?? null, "supplyApy", "Morpho supply APY (after market fee)"),
    ...rewards("supply"),
    ...y("NET_APY", "EARN", api.state?.netSupplyApy ?? null, "netSupplyApy", "Morpho net supply APY (incl. rewards)"),
  ];
  const borrowYields = [
    ...y("BORROW_APY", "PAY", api.state?.borrowApy ?? null, "borrowApy", "Morpho borrow APY"),
    ...rewards("borrow"),
    ...y("NET_APY", "PAY", api.state?.netBorrowApy ?? null, "netBorrowApy", "Morpho net borrow APY (after rewards)"),
  ];
  const collTvl =
    api.state?.collateralAssets !== null && api.state?.collateralAssets !== undefined
      ? measured(amountWithUsd(coll, api.state.collateralAssets, collPx), "SUPPLIED", { ...apiMarketSrc, method: "state.collateralAssets" }, apiFresh, "VERIFIED_OFFICIAL_API")
      : null;

  const lend = make("LEND", loan, lendYields, { inputAssets: [loan], outputAssets: [loan], tvl: supplyTvl }, `Supply ${loan.symbol} to Morpho market ${coll.symbol}/${loan.symbol} (LLTV ${formatFixed18(p.lltv * 100n)}%)`);
  const collateral = make(
    "COLLATERAL",
    coll,
    borrowYields,
    {
      inputAssets: [coll],
      outputAssets: [loan],
      collateralAssets: [coll],
      borrowAssets: [loan],
      tvl: collTvl,
      liquidation: {
        lltv: lltvMeasured,
        liquidationIncentiveFactor: measured<Fixed18>(lif, "COMPUTED", paramsSrc, paramsFresh, "VERIFIED_ONCHAIN", "min(1.15, 1 / (1 − 0.3 × (1 − LLTV)))"),
        priceAuthority: `Morpho market oracle ${p.oracle}`,
        rule: "liquidatable when borrowed > floor(floor(collateral × oraclePrice / 1e36) × LLTV / 1e18) (Morpho._isHealthy)",
        collateralPrice,
      },
      term: { maturity: null, lockSeconds: null, withdrawal: "INSTANT_SUBJECT_TO_LIQUIDITY" },
    },
    `Use ${coll.symbol} as collateral on Morpho, borrow ${loan.symbol} (LLTV ${formatFixed18(p.lltv * 100n)}%)`,
  );
  return { opportunities: [collateral, lend], warnings, skipped: null };
}
