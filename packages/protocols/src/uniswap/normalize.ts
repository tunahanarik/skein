/**
 * Pure normalization: one Uniswap v3 pool (discovery log + onchain identity + onchain state +
 * Phase 1 prices) → one TradeMarket and two DIRECT TRADE opportunities (one per direction).
 *
 * Source policy:
 *   identity (tokens, fee, factory origin)  onchain; PoolCreated log vs pool views vs factory.getPool
 *   price                                   onchain slot0.sqrtPriceX96 (DEX_MARKET_PRICE, exact)
 *   reserves                                onchain token.balanceOf(pool)
 *   USD (reserves, TVL)                     Phase 1 Price Service (PORTFOLIO_PRICE), canonical tokens only
 * No API is used. The DEX price never replaces the portfolio price; large gaps are warnings.
 */
import type { Address } from "viem";
import { classifyFreshness, type FreshnessInfo } from "@skein/core/config/freshness";
import { MARKET_PRICE_DIVERGENCE_PCT } from "@skein/robinhood/config/trade";
import { WAD } from "@skein/core/lib/fixed";
import { formatFixed, usdValueE18, USD_DECIMALS } from "@skein/core/lib/units";
import { opportunityId, type AmountWithUsd, type AssetRef, type Known, type Measured, type Opportunity, type OpportunityRisk } from "@skein/core/model/opportunity";
import type { DataSource } from "@skein/core/model/provenance";
import type { MarketPrice, MarketState, TradeMarket } from "@skein/core/model/trade";
import type { VerificationStatus } from "@skein/core/model/verification";
import { warn, type Warning } from "@skein/core/model/warnings";
import type { AssetPrice } from "@skein/engine/opportunities/assetPricing";
import { openEndedLifecycle } from "@skein/engine/opportunities/lifecycle";
import { directRoute } from "@skein/engine/trade/graph";
import { UNISWAP_V3, type V3Dialect } from "./constants.js";
import { differsByMoreThanPct } from "../pendle/math.js";
import { price0In1, price1In0 } from "./math.js";
import type { DiscoveredPool, PoolIdentity, PoolState } from "./onchain.js";

export const PROTOCOL = UNISWAP_V3.protocol;
export const VENUE_KIND = UNISWAP_V3.venueKind;

export interface UniswapNormalizeContext {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  nowS: number;
  generatedAt: string;
  resolveAsset: (address: Address, reportedSymbol: string | null, reportedDecimals: number | null) => AssetRef;
  priceOf: (assetKey: string) => AssetPrice;
  isLookalike: (ref: AssetRef) => boolean;
  /** Which v3-style DEX (default Uniswap v3). */
  dialect?: V3Dialect;
}

export interface PoolInput {
  discovered: DiscoveredPool;
  identity: PoolIdentity;
  identityBlock: { number: bigint; timestamp: bigint };
  state: PoolState | null;
}

const iso = (s: bigint | number) => new Date(Number(s) * 1000).toISOString();
const known = <T>(value: T, source: DataSource): Known<T> => ({ known: true, value, source });
const unknown = (reason: string): Known<never> => ({ known: false, reason });

export function marketIdOf(chainId: number, pool: Address, d: V3Dialect = UNISWAP_V3): string {
  return `${chainId}:${d.protocol.id}:${d.venueKind}:${pool.toLowerCase()}`;
}

export function normalizePool(input: PoolInput, ctx: UniswapNormalizeContext): { market: TradeMarket; opportunities: Opportunity[]; warnings: Warning[] } {
  const { identity: id, state: st } = input;
  const d = ctx.dialect ?? UNISWAP_V3;
  const pool = id.pool;
  // Dynamic-fee dialects: the fee read with this state; static: the identity's fee tier.
  const feePpm = d.dynamicFee ? (st?.fee ?? id.fee) : id.fee;
  const short = `${pool.slice(0, 10)}…`;
  const warnings: Warning[] = [];

  const chainSrc = (method: string, contract: Address, block = ctx.blockNumber): DataSource => ({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: block, observedAt: ctx.generatedAt });
  const identitySrc = (method: string) => chainSrc(method, pool, id.readAtBlock);
  // State values carry the block they were read at (secondary pools may reuse an older read).
  const stBlock = st?.atBlock ?? { number: ctx.blockNumber, timestamp: ctx.blockTimestamp };
  const reservesMethod = d.reservesMethod ?? "token.balanceOf(pool)";
  const stateSrc = chainSrc(`slot0() / liquidity() / ${reservesMethod}`, pool, stBlock.number);
  const blockFresh: FreshnessInfo = classifyFreshness("ONCHAIN_STATE", Number(stBlock.timestamp), ctx.nowS);
  const configFresh = classifyFreshness("PROTOCOL_MARKET_CONFIG", Number(input.identityBlock.timestamp), ctx.nowS);
  const measured = <T>(value: T, origin: Measured<T>["origin"], source: DataSource, freshness: FreshnessInfo, verification: VerificationStatus, formula?: string): Measured<T> => ({
    value,
    origin,
    source,
    observedAt: iso(source.blockNumber === stBlock.number ? stBlock.timestamp : ctx.blockTimestamp),
    freshness,
    verification,
    ...(formula ? { formula } : {}),
  });

  // ---- identity ----
  const m0 = id.meta[id.token0.toLowerCase()];
  const m1 = id.meta[id.token1.toLowerCase()];
  const a0 = ctx.resolveAsset(id.token0, m0?.symbol ?? null, m0?.decimals ?? null);
  const a1 = ctx.resolveAsset(id.token1, m1?.symbol ?? null, m1?.decimals ?? null);
  const identityOk = id.checks.every((c) => c.ok === true);
  const origin = (name: string) => id.checks.find((c) => c.check.startsWith(name))?.ok === true;
  const [oA, oB] = d.originChecks ?? ["pool.factory()", "factory.getPool"];
  const originVerified = origin(oA) && origin(oB);
  if (!identityOk) warnings.push(warn("POOL_UNVERIFIED", `${d.label} pool ${short}: checks not passed: ${id.checks.filter((c) => c.ok !== true).map((c) => `${c.check} (${c.ok === null ? "unreadable" : "false"})`).join("; ")}`));
  for (const ref of [a0, a1]) {
    if (!ref.canonical) warnings.push(warn(ctx.isLookalike(ref) ? "LOOKALIKE_TOKEN" : "NON_CANONICAL_ASSET", `${d.label} pool ${short}: ${ref.symbol} ${ref.address} is not in the canonical registry${ctx.isLookalike(ref) ? " but uses a canonical symbol" : ""}`, { assetKey: ref.key }));
  }

  // ---- state ----
  const state: MarketState = !st || st.sqrtPriceX96 === null || st.liquidity === null ? "UNREADABLE" : st.sqrtPriceX96 === 0n ? "UNINITIALIZED" : st.liquidity === 0n ? "NO_ACTIVE_LIQUIDITY" : "ACTIVE";
  if (state === "NO_ACTIVE_LIQUIDITY") warnings.push(warn("NO_ACTIVE_LIQUIDITY", `${d.label} pool ${short}: no in-range liquidity at the current price; a swap would have to move the price to reach liquidity`));
  if (state === "UNREADABLE") warnings.push(warn("MARKET_UNVERIFIED_ONCHAIN", `${d.label} pool ${short}: state unreadable (${st?.errors.join("; ") ?? "not read"})`));

  // ---- price (DEX_MARKET_PRICE) ----
  const priceFormula = "sqrtPriceX96² / 2^192 × 10^(dec0 − dec1)";
  const p01 = st?.sqrtPriceX96 ? price0In1(st.sqrtPriceX96, a0.decimals, a1.decimals) : null;
  const p10 = st?.sqrtPriceX96 ? price1In0(st.sqrtPriceX96, a0.decimals, a1.decimals) : null;
  const price: MarketPrice | null = p01 === null ? null : { kind: "DEX_MARKET_PRICE", base: a0, quote: a1, value: measured(p01, "COMPUTED", chainSrc("slot0().sqrtPriceX96", pool, stBlock.number), blockFresh, "VERIFIED_ONCHAIN", priceFormula) };
  const priceInverse: MarketPrice | null = p10 === null ? null : { kind: "DEX_MARKET_PRICE", base: a1, quote: a0, value: measured(p10, "COMPUTED", chainSrc("slot0().sqrtPriceX96", pool, stBlock.number), blockFresh, "VERIFIED_ONCHAIN", "2^192 / sqrtPriceX96² × 10^(dec1 − dec0)") };

  // ---- reserves and TVL (Phase 1 prices; unknown side ⇒ TVL unknown, never $0) ----
  const px0 = ctx.priceOf(a0.key).price;
  const px1 = ctx.priceOf(a1.key).price;
  const reserve = (ref: AssetRef, raw: bigint | null | undefined, px: AssetPrice["price"], token: Address): Measured<AmountWithUsd> | null => {
    if (raw === null || raw === undefined) return null;
    const usd = px ? usdValueE18(raw, ref.decimals, px.raw, px.decimals) : null;
    return measured({ asset: ref, amount: { raw, decimals: ref.decimals, display: formatFixed(raw, ref.decimals) }, usd: usd === null ? null : { e18: usd, display: formatFixed(usd, USD_DECIMALS) } }, d.reservesMethod ? "COMPUTED" : "SUPPLIED", chainSrc(d.reservesMethod ?? "balanceOf(pool)", d.reservesMethod ? pool : token, stBlock.number), blockFresh, "VERIFIED_ONCHAIN");
  };
  const r0 = reserve(a0, st?.balance0, px0, id.token0);
  const r1 = reserve(a1, st?.balance1, px1, id.token1);
  const tvlE18 = r0?.value.usd && r1?.value.usd ? r0.value.usd.e18 + r1.value.usd.e18 : null;
  const tvl = tvlE18 === null ? null : measured({ e18: tvlE18, display: formatFixed(tvlE18, USD_DECIMALS) }, "COMPUTED", stateSrc, blockFresh, "VERIFIED_ONCHAIN", `Σ ${reservesMethod} × Phase 1 USD price`);
  if ((r0 || r1) && tvl === null) warnings.push(warn("UNPRICED_METRIC", `${d.label} pool ${short}: ${[a0, a1].filter((a) => !ctx.priceOf(a.key).price).map((a) => a.symbol).join(", ")} not priced by the Price Service; TVL unknown`));
  if (r0 || r1) {
    const rw = d.reservesWarning ?? { code: "RESERVES_INCLUDE_UNCOLLECTED_FEES" as const, text: "pool balances include LP fees not yet collected and out-of-range liquidity; TVL is not executable depth" };
    warnings.push(warn(rw.code, `${d.label} pool ${short}: ${rw.text}`));
  }

  // ---- DEX vs portfolio price divergence (recorded, not resolved) ----
  if (p01 !== null && px0 && px1 && a0.canonical && a1.canonical) {
    const usd0 = usdValueE18(10n ** BigInt(a0.decimals), a0.decimals, px0.raw, px0.decimals);
    const usd1 = usdValueE18(10n ** BigInt(a1.decimals), a1.decimals, px1.raw, px1.decimals);
    if (usd1 > 0n) {
      const portfolio = (usd0 * WAD) / usd1; // token1 per token0 implied by portfolio prices
      if (differsByMoreThanPct(portfolio, p01, MARKET_PRICE_DIVERGENCE_PCT)) {
        warnings.push(
          warn("MARKET_PRICE_DIVERGENCE", `${d.label} pool ${short}: DEX price ${formatFixed(p01, 18)} ${a1.symbol}/${a0.symbol} vs portfolio-implied ${formatFixed(portfolio, 18)} (> ${MARKET_PRICE_DIVERGENCE_PCT}%); neither is declared correct`, {
            details: { dexPrice: formatFixed(p01, 18), portfolioPrice: formatFixed(portfolio, 18) },
          }),
        );
      }
    }
  }

  const verificationStatus: VerificationStatus = !identityOk ? "UNVERIFIED" : a0.canonical && a1.canonical && state !== "UNREADABLE" ? "VERIFIED_ONCHAIN" : "UNVERIFIED";
  const market: TradeMarket = {
    id: marketIdOf(ctx.chainId, pool, d),
    chainId: ctx.chainId,
    protocol: { ...d.protocol },
    venueKind: d.venueKind,
    marketId: pool.toLowerCase(),
    address: pool,
    assets: [a0, a1],
    fee: d.dynamicFee
      ? measured({ ppm: feePpm, kind: "DYNAMIC" as const }, "SUPPLIED", chainSrc("fee()", pool, stBlock.number), blockFresh, identityOk ? "VERIFIED_ONCHAIN" : "UNVERIFIED")
      : measured({ ppm: feePpm, kind: "STATIC" as const }, "SUPPLIED", identitySrc("fee()"), configFresh, identityOk ? "VERIFIED_ONCHAIN" : "UNVERIFIED"),
    price,
    priceInverse,
    liquidity: {
      tvl,
      reserves: [r0, r1].filter((x): x is Measured<AmountWithUsd> => !!x),
      activeLiquidity: st?.liquidity == null ? null : measured(st.liquidity, "SUPPLIED", chainSrc("liquidity()", pool, stBlock.number), blockFresh, "VERIFIED_ONCHAIN"),
      activeLiquidityMeaning: `${d.label} in-range liquidity L at the current tick (sqrt(x·y) units); not a token or USD amount`,
    },
    state,
    volume24h: { status: "UNKNOWN", reason: "no verified 24h volume source (needs Swap-log indexing; decision P4-5)" },
    originVerified,
    verificationStatus,
    provenance: [
      input.discovered.createdAtBlock !== null ? chainSrc("PoolCreated event", d.factory, input.discovered.createdAtBlock) : chainSrc("factory.getPool(token, hub, key) sweep", d.factory, id.readAtBlock),
      identitySrc("factory/token0/token1/fee/tickSpacing + factory.getPool"),
      stateSrc,
    ],
    conflicts: [],
    warnings,
    freshness: state === "UNREADABLE" ? configFresh : blockFresh,
    details: { feePpm, tickSpacing: id.tickSpacing },
  };

  // ---- two DIRECT TRADE opportunities ----
  const blockers = state === "UNREADABLE" ? (["STATE_UNKNOWN"] as const) : state === "ACTIVE" ? ([] as const) : (["MARKET_INACTIVE"] as const);
  const risk = (): OpportunityRisk => ({
    oracle: null,
    lltv: unknown("not a lending market"),
    utilization: unknown("not a lending market"),
    availableLiquidityUsd: tvl ? known(tvl.value, stateSrc) : unknown("a pool token is unpriced or balances unreadable"),
    marketSizeUsd: tvl ? known(tvl.value, stateSrc) : unknown("a pool token is unpriced or balances unreadable"),
    rewardDependence: unknown("not a yield opportunity"),
    parameterMutability: known(d.mutability, { type: "OFFICIAL_DOCS", provider: `${d.protocol.id}-docs`, url: d.mutabilitySource, observedAt: ctx.generatedAt }),
    protocolListed: unknown("Uniswap has no onchain listing; pools are permissionless"),
    protocolWarnings: [],
    allAssetsCanonical: a0.canonical && a1.canonical,
  });
  const opps: Opportunity[] = [a0, a1].map((inAsset) => {
    const outAsset = inAsset.key === a0.key ? a1 : a0;
    const outReserve = inAsset.key === a0.key ? r1 : r0;
    const route = directRoute(market, inAsset.key);
    const pct = (feePpm / 10_000).toFixed(feePpm % 100 === 0 ? 2 : 4).replace(/0+$/, "").replace(/\.$/, "");
    return {
      id: opportunityId(ctx.chainId, d.protocol.id, "TRADE", d.venueKind, `${pool}:${inAsset.address}`),
      chainId: ctx.chainId,
      protocol: { ...d.protocol },
      category: "TRADE",
      title: `Trade ${inAsset.symbol} → ${outAsset.symbol} on ${d.label} (${pct}%${d.dynamicFee ? " dynamic fee" : ""} pool)`,
      venue: { kind: d.venueKind, id: pool.toLowerCase(), address: pool },
      primaryAsset: inAsset,
      inputAssets: [inAsset],
      outputAssets: [outAsset],
      collateralAssets: [],
      borrowAssets: [],
      yields: [],
      tvl: tvl ? { ...tvl, value: { asset: inAsset, amount: null, usd: tvl.value } } : null,
      // Upper bound of what one swap can pay out: the pool's balance of the output token.
      availableLiquidity: outReserve,
      liquidityKind: "POOL_LIQUIDITY",
      utilization: null,
      liquidation: null,
      term: null,
      lifecycle: openEndedLifecycle({ number: ctx.blockNumber, timestamp: ctx.blockTimestamp }, [...blockers]),
      entry: {
        kind: "DIRECT",
        requiredAsset: inAsset,
        steps: [{ action: "SWAP", from: inAsset, to: outAsset, venue: `${d.label} pool ${pool}`, verified: originVerified && state === "ACTIVE", source: stateSrc }],
        singleTransactionAvailable: known(true, { type: "OFFICIAL_DOCS", provider: `${d.protocol.id}-deployments`, url: d.deploymentSource, method: "a swap router is deployed (recorded only; not used, not simulated)", observedAt: ctx.generatedAt }),
        note: "Market only — no amount is implied. Request an INDICATIVE quote with an explicit amount. Nothing here is executable.",
      },
      relationships: [],
      eligibility: null,
      contracts: [
        { role: "pool", address: pool },
        { role: "v3Factory", address: d.factory },
      ],
      risk: risk(),
      details: {
        kind: "UNISWAP_V3_POOL",
        pool,
        token0: a0,
        token1: a1,
        feePpm,
        tickSpacing: id.tickSpacing,
        sqrtPriceX96: st?.sqrtPriceX96 ?? null,
        tick: st?.tick ?? null,
        liquidity: st?.liquidity ?? null,
        identityChecks: id.checks,
        createdAtBlock: input.discovered.createdAtBlock,
        discoveredVia: input.discovered.via,
      },
      provenance: market.provenance,
      conflicts: [],
      warnings: [...warnings],
      freshness: market.freshness,
      verificationStatus,
      observedAt: iso(ctx.blockTimestamp),
      generatedAt: ctx.generatedAt,
      trade: { market, route },
    } satisfies Opportunity;
  });
  return { market, opportunities: opps, warnings };
}
