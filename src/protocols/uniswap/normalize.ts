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
import { classifyFreshness, type FreshnessInfo } from "../../config/freshness.js";
import { MARKET_PRICE_DIVERGENCE_PCT } from "../../config/trade.js";
import { WAD } from "../../lib/fixed.js";
import { formatFixed, usdValueE18, USD_DECIMALS } from "../../lib/units.js";
import { opportunityId, type AmountWithUsd, type AssetRef, type Known, type Measured, type Opportunity, type OpportunityRisk } from "../../model/opportunity.js";
import type { DataSource } from "../../model/provenance.js";
import type { MarketPrice, MarketState, TradeMarket } from "../../model/trade.js";
import type { VerificationStatus } from "../../model/verification.js";
import { warn, type Warning } from "../../model/warnings.js";
import type { AssetPrice } from "../../opportunities/assetPricing.js";
import { openEndedLifecycle } from "../../opportunities/lifecycle.js";
import { directRoute } from "../../trade/graph.js";
import { UNISWAP_DEPLOYMENT_SOURCE, UNISWAP_READ_CONTRACTS } from "./constants.js";
import { differsByMoreThanPct } from "../pendle/math.js";
import { price0In1, price1In0 } from "./math.js";
import type { DiscoveredPool, PoolIdentity, PoolState } from "./onchain.js";

export const PROTOCOL = { id: "uniswap", name: "Uniswap" } as const;
export const VENUE_KIND = "uniswap-v3-pool";

export interface UniswapNormalizeContext {
  chainId: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  nowS: number;
  generatedAt: string;
  resolveAsset: (address: Address, reportedSymbol: string | null, reportedDecimals: number | null) => AssetRef;
  priceOf: (assetKey: string) => AssetPrice;
  isLookalike: (ref: AssetRef) => boolean;
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

export function marketIdOf(chainId: number, pool: Address): string {
  return `${chainId}:${PROTOCOL.id}:${VENUE_KIND}:${pool.toLowerCase()}`;
}

export function normalizePool(input: PoolInput, ctx: UniswapNormalizeContext): { market: TradeMarket; opportunities: Opportunity[]; warnings: Warning[] } {
  const { identity: id, state: st } = input;
  const pool = id.pool;
  const short = `${pool.slice(0, 10)}…`;
  const warnings: Warning[] = [];

  const chainSrc = (method: string, contract: Address, block = ctx.blockNumber): DataSource => ({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: block, observedAt: ctx.generatedAt });
  const identitySrc = (method: string) => chainSrc(method, pool, id.readAtBlock);
  // State values carry the block they were read at (secondary pools may reuse an older read).
  const stBlock = st?.atBlock ?? { number: ctx.blockNumber, timestamp: ctx.blockTimestamp };
  const stateSrc = chainSrc("slot0() / liquidity() / token.balanceOf(pool)", pool, stBlock.number);
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
  const originVerified = origin("pool.factory()") && origin("factory.getPool");
  if (!identityOk) warnings.push(warn("POOL_UNVERIFIED", `Uniswap v3 pool ${short}: checks not passed: ${id.checks.filter((c) => c.ok !== true).map((c) => `${c.check} (${c.ok === null ? "unreadable" : "false"})`).join("; ")}`));
  for (const ref of [a0, a1]) {
    if (!ref.canonical) warnings.push(warn(ctx.isLookalike(ref) ? "LOOKALIKE_TOKEN" : "NON_CANONICAL_ASSET", `Uniswap v3 pool ${short}: ${ref.symbol} ${ref.address} is not in the canonical registry${ctx.isLookalike(ref) ? " but uses a canonical symbol" : ""}`, { assetKey: ref.key }));
  }

  // ---- state ----
  const state: MarketState = !st || st.sqrtPriceX96 === null || st.liquidity === null ? "UNREADABLE" : st.sqrtPriceX96 === 0n ? "UNINITIALIZED" : st.liquidity === 0n ? "NO_ACTIVE_LIQUIDITY" : "ACTIVE";
  if (state === "NO_ACTIVE_LIQUIDITY") warnings.push(warn("NO_ACTIVE_LIQUIDITY", `Uniswap v3 pool ${short}: no in-range liquidity at the current price; a swap would have to move the price to reach liquidity`));
  if (state === "UNREADABLE") warnings.push(warn("MARKET_UNVERIFIED_ONCHAIN", `Uniswap v3 pool ${short}: state unreadable (${st?.errors.join("; ") ?? "not read"})`));

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
    return measured({ asset: ref, amount: { raw, decimals: ref.decimals, display: formatFixed(raw, ref.decimals) }, usd: usd === null ? null : { e18: usd, display: formatFixed(usd, USD_DECIMALS) } }, "SUPPLIED", chainSrc("balanceOf(pool)", token, stBlock.number), blockFresh, "VERIFIED_ONCHAIN");
  };
  const r0 = reserve(a0, st?.balance0, px0, id.token0);
  const r1 = reserve(a1, st?.balance1, px1, id.token1);
  const tvlE18 = r0?.value.usd && r1?.value.usd ? r0.value.usd.e18 + r1.value.usd.e18 : null;
  const tvl = tvlE18 === null ? null : measured({ e18: tvlE18, display: formatFixed(tvlE18, USD_DECIMALS) }, "COMPUTED", stateSrc, blockFresh, "VERIFIED_ONCHAIN", "Σ token.balanceOf(pool) × Phase 1 USD price");
  if ((r0 || r1) && tvl === null) warnings.push(warn("UNPRICED_METRIC", `Uniswap v3 pool ${short}: ${[a0, a1].filter((a) => !ctx.priceOf(a.key).price).map((a) => a.symbol).join(", ")} not priced by the Price Service; TVL unknown`));
  if (r0 || r1) warnings.push(warn("RESERVES_INCLUDE_UNCOLLECTED_FEES", `Uniswap v3 pool ${short}: pool balances include LP fees not yet collected and out-of-range liquidity; TVL is not executable depth`));

  // ---- DEX vs portfolio price divergence (recorded, not resolved) ----
  if (p01 !== null && px0 && px1 && a0.canonical && a1.canonical) {
    const usd0 = usdValueE18(10n ** BigInt(a0.decimals), a0.decimals, px0.raw, px0.decimals);
    const usd1 = usdValueE18(10n ** BigInt(a1.decimals), a1.decimals, px1.raw, px1.decimals);
    if (usd1 > 0n) {
      const portfolio = (usd0 * WAD) / usd1; // token1 per token0 implied by portfolio prices
      if (differsByMoreThanPct(portfolio, p01, MARKET_PRICE_DIVERGENCE_PCT)) {
        warnings.push(
          warn("MARKET_PRICE_DIVERGENCE", `Uniswap v3 pool ${short}: DEX price ${formatFixed(p01, 18)} ${a1.symbol}/${a0.symbol} vs portfolio-implied ${formatFixed(portfolio, 18)} (> ${MARKET_PRICE_DIVERGENCE_PCT}%); neither is declared correct`, {
            details: { dexPrice: formatFixed(p01, 18), portfolioPrice: formatFixed(portfolio, 18) },
          }),
        );
      }
    }
  }

  const verificationStatus: VerificationStatus = !identityOk ? "UNVERIFIED" : a0.canonical && a1.canonical && state !== "UNREADABLE" ? "VERIFIED_ONCHAIN" : "UNVERIFIED";
  const market: TradeMarket = {
    id: marketIdOf(ctx.chainId, pool),
    chainId: ctx.chainId,
    protocol: { ...PROTOCOL },
    venueKind: VENUE_KIND,
    marketId: pool.toLowerCase(),
    address: pool,
    assets: [a0, a1],
    fee: measured({ ppm: id.fee, kind: "STATIC" as const }, "SUPPLIED", identitySrc("fee()"), configFresh, identityOk ? "VERIFIED_ONCHAIN" : "UNVERIFIED"),
    price,
    priceInverse,
    liquidity: {
      tvl,
      reserves: [r0, r1].filter((x): x is Measured<AmountWithUsd> => !!x),
      activeLiquidity: st?.liquidity == null ? null : measured(st.liquidity, "SUPPLIED", chainSrc("liquidity()", pool, stBlock.number), blockFresh, "VERIFIED_ONCHAIN"),
      activeLiquidityMeaning: "Uniswap v3 in-range liquidity L at the current tick (sqrt(x·y) units); not a token or USD amount",
    },
    state,
    originVerified,
    verificationStatus,
    provenance: [
      input.discovered.createdAtBlock !== null ? chainSrc("PoolCreated event", UNISWAP_READ_CONTRACTS.v3Factory, input.discovered.createdAtBlock) : chainSrc("factory.getPool(token, hub, fee) sweep", UNISWAP_READ_CONTRACTS.v3Factory, id.readAtBlock),
      identitySrc("factory/token0/token1/fee/tickSpacing + factory.getPool"),
      stateSrc,
    ],
    conflicts: [],
    warnings,
    freshness: state === "UNREADABLE" ? configFresh : blockFresh,
    details: { feePpm: id.fee, tickSpacing: id.tickSpacing },
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
    parameterMutability: known("token0, token1 and fee are fixed per v3 pool at creation; the factory owner can only enable fee tiers and set a protocol fee share", { type: "OFFICIAL_DOCS", provider: "uniswap-v3-core", url: "https://github.com/Uniswap/v3-core", observedAt: ctx.generatedAt }),
    protocolListed: unknown("Uniswap has no onchain listing; pools are permissionless"),
    protocolWarnings: [],
    allAssetsCanonical: a0.canonical && a1.canonical,
  });
  const opps: Opportunity[] = [a0, a1].map((inAsset) => {
    const outAsset = inAsset.key === a0.key ? a1 : a0;
    const outReserve = inAsset.key === a0.key ? r1 : r0;
    const route = directRoute(market, inAsset.key);
    const pct = (id.fee / 10_000).toFixed(id.fee % 100 === 0 ? 2 : 4).replace(/0+$/, "").replace(/\.$/, "");
    return {
      id: opportunityId(ctx.chainId, PROTOCOL.id, "TRADE", VENUE_KIND, `${pool}:${inAsset.address}`),
      chainId: ctx.chainId,
      protocol: { ...PROTOCOL },
      category: "TRADE",
      title: `Trade ${inAsset.symbol} → ${outAsset.symbol} on Uniswap v3 (${pct}% pool)`,
      venue: { kind: VENUE_KIND, id: pool.toLowerCase(), address: pool },
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
        steps: [{ action: "SWAP", from: inAsset, to: outAsset, venue: `Uniswap v3 pool ${pool}`, verified: originVerified && state === "ACTIVE", source: stateSrc }],
        singleTransactionAvailable: known(true, { type: "OFFICIAL_DOCS", provider: "uniswap-deployments", url: UNISWAP_DEPLOYMENT_SOURCE, method: "SwapRouter02 / UniversalRouter are deployed (recorded only; not used, not simulated)", observedAt: ctx.generatedAt }),
        note: "Market only — no amount is implied. Request an INDICATIVE quote with an explicit amount. Nothing here is executable.",
      },
      relationships: [],
      eligibility: null,
      contracts: [
        { role: "pool", address: pool },
        { role: "v3Factory", address: UNISWAP_READ_CONTRACTS.v3Factory },
      ],
      risk: risk(),
      details: {
        kind: "UNISWAP_V3_POOL",
        pool,
        token0: a0,
        token1: a1,
        feePpm: id.fee,
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
