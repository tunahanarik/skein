/**
 * Spark Savings (spUSDG) adapter — onchain only (no official rates API exists).
 *
 * Deployment: spark-address-registry `src/Robinhood.sol` (docs/research/protocols.md). Checked live
 * 2026-09-24: asset() = USDG, decimals 6, vsr ≈ 1.0000000010909e27 (3.50 % APY), depositCap 500M.
 *
 * APY = vsr^(seconds per year) − 1, computed in ray (1e27) with exact integer exponentiation by
 * squaring (rpow, round-half-up per step as in the savings-rate contracts), then scaled to 1e18.
 * The vault is ERC-4626: deposit USDG, receive spUSDG; value accrues per second.
 */
import { parseAbi, type Address } from "viem";
import { classifyFreshness } from "../../config/freshness.js";
import { PROTOCOLS } from "../../config/protocols.js";
import { formatFixed, usdValueE18, USD_DECIMALS } from "../../lib/units.js";
import { opportunityId, type AmountWithUsd, type AssetRef, type Measured, type Opportunity, type OpportunityCategory, type YieldMetric } from "../../model/opportunity.js";
import type { Position } from "../../model/position.js";
import type { DataSource } from "../../model/provenance.js";
import { weakestStatus } from "../../model/verification.js";
import { warn, type Warning } from "../../model/warnings.js";
import type { AdapterCapabilities, AdapterContext, AdapterResult, OpportunityAdapter } from "../../opportunities/adapter.js";
import { priceCanonicalAssets } from "../../opportunities/assetPricing.js";
import { openEndedLifecycle } from "../../opportunities/lifecycle.js";

export const PROTOCOL = { id: "spark-savings", name: "Spark" } as const;
const CONFIG = PROTOCOLS.find((p) => p.id === "spark-savings")!;
export const SP_USDG: Address = CONFIG.contracts.spUSDG!;
const SECONDS_PER_YEAR = 31_536_000n;
export const RAY = 10n ** 27n;

export const savingsAbi = parseAbi([
  "function vsr() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function asset() view returns (address)",
  "function depositCap() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);

/** x^n in ray precision (x, result scaled by 1e27), rounding half up at every multiply. */
export function rpow(x: bigint, n: bigint): bigint {
  let z = n % 2n === 1n ? x : RAY;
  const half = RAY / 2n;
  for (let nn = n / 2n; nn > 0n; nn /= 2n) {
    x = (x * x + half) / RAY;
    if (nn % 2n === 1n) z = (z * x + half) / RAY;
  }
  return z;
}

/** Annual yield (1e18) of a per-second ray rate. */
export function apyFromPerSecondRay(rateRay: bigint): bigint {
  if (rateRay < RAY) return 0n;
  return (rpow(rateRay, SECONDS_PER_YEAR) - RAY) / 10n ** 9n;
}

const ms = (t: number) => Math.round(performance.now() - t);

export class SparkSavingsAdapter implements OpportunityAdapter {
  readonly protocol = { ...PROTOCOL };
  readonly categories: readonly OpportunityCategory[] = ["VAULT"];
  readonly capabilities: AdapterCapabilities = { discovery: true, assetFiltering: false, userPositions: true, singleOpportunity: false, execution: false };

  supportsCategory(c: OpportunityCategory): boolean {
    return this.categories.includes(c);
  }

  private src(ctx: AdapterContext, method: string): DataSource {
    return { type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract: SP_USDG, method, blockNumber: ctx.blockNumber, observedAt: ctx.now().toISOString() };
  }

  async getOpportunities(ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>> {
    const t0 = performance.now();
    const warnings: Warning[] = [];
    const r = await ctx.reader.multicall(
      (["vsr", "totalAssets", "asset", "depositCap", "decimals"] as const).map((functionName) => ({ address: SP_USDG, abi: savingsAbi, functionName })),
      { blockNumber: ctx.blockNumber },
    );
    const val = <T>(i: number): T | null => (r[i]?.status === "success" ? (r[i] as { result: T }).result : null);
    const vsr = val<bigint>(0);
    const totalAssets = val<bigint>(1);
    const assetAddr = val<Address>(2);
    const cap = val<bigint>(3);
    const dec = val<number>(4);
    if (vsr === null || assetAddr === null || dec === null) {
      return { data: [], status: "UNKNOWN", issues: [{ scope: "spUSDG", message: "vsr/asset/decimals unreadable", severity: "FATAL" }], warnings, timingsMs: { total: ms(t0) } };
    }
    const reg = ctx.registry.get(ctx.chainId, assetAddr);
    if (!reg?.canonical || reg.decimals !== Number(dec)) {
      return { data: [], status: "UNKNOWN", issues: [{ scope: "spUSDG", message: "asset() is not the canonical USDG (or decimals differ); not published", severity: "FATAL" }], warnings, timingsMs: { total: ms(t0) } };
    }
    const asset: AssetRef = { key: reg.key, chainId: ctx.chainId, address: reg.address!, symbol: reg.symbol, decimals: reg.decimals, canonical: true, registryType: reg.type };
    const share: AssetRef = { key: `${ctx.chainId}:${SP_USDG.toLowerCase()}`, chainId: ctx.chainId, address: SP_USDG, symbol: "spUSDG", decimals: Number(dec), canonical: false, registryType: null };
    const { priceOf } = await priceCanonicalAssets(ctx, [asset.key]);
    const px = priceOf(asset.key).price;
    const amt = (raw: bigint): AmountWithUsd => {
      const usd = px ? usdValueE18(raw, asset.decimals, px.raw, px.decimals) : null;
      return { asset, amount: { raw, decimals: asset.decimals, display: formatFixed(raw, asset.decimals) }, usd: usd === null ? null : { e18: usd, display: formatFixed(usd, USD_DECIMALS) } };
    };
    const observedAt = new Date(Number(ctx.blockTimestamp) * 1000).toISOString();
    const fresh = classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), Math.floor(ctx.now().getTime() / 1000));
    const tvl: Measured<AmountWithUsd> | null = totalAssets !== null ? { value: amt(totalAssets), origin: "SUPPLIED", source: this.src(ctx, "totalAssets()"), observedAt, freshness: fresh, verification: "VERIFIED_ONCHAIN" } : null;
    const apy = apyFromPerSecondRay(vsr);
    const yields: YieldMetric[] = [
      {
        type: "NET_APY",
        side: "EARN",
        basis: "VARIABLE",
        compounding: "COMPOUNDED",
        window: "instant",
        denominatedIn: asset,
        label: "Spark Savings rate (vsr, per-second compounding, annualised)",
        value: apy,
        origin: "COMPUTED",
        formula: "vsr^31536000 − 1 (ray, rpow)",
        source: this.src(ctx, "vsr()"),
        observedAt,
        freshness: fresh,
        verification: "VERIFIED_ONCHAIN",
      } as YieldMetric,
    ];
    const room = cap !== null && totalAssets !== null ? (cap > totalAssets ? cap - totalAssets : 0n) : null;
    if (room === 0n) warnings.push(warn("PROTOCOL_WARNING", "spUSDG: deposit cap reached"));
    const opp: Opportunity = {
      id: opportunityId(ctx.chainId, PROTOCOL.id, "VAULT", "erc4626-savings", SP_USDG),
      chainId: ctx.chainId,
      protocol: { ...PROTOCOL },
      category: "VAULT",
      title: `Deposit ${asset.symbol} into Spark Savings (spUSDG)`,
      venue: { kind: "ERC4626_SAVINGS", id: SP_USDG.toLowerCase(), address: SP_USDG },
      primaryAsset: asset,
      inputAssets: [asset],
      outputAssets: [share],
      collateralAssets: [],
      borrowAssets: [],
      yields,
      tvl,
      // Deposit room under the cap: what can still be entered now.
      availableLiquidity: null,
      liquidityKind: "INSTANT_WITHDRAWAL",
      utilization: null,
      liquidation: null,
      term: { maturity: null, lockSeconds: null, withdrawal: "INSTANT_SUBJECT_TO_LIQUIDITY" },
      lifecycle: openEndedLifecycle({ number: ctx.blockNumber, timestamp: ctx.blockTimestamp }, room === 0n ? ["DEPOSIT_DISABLED"] : []),
      entry: {
        kind: "DIRECT",
        requiredAsset: asset,
        steps: [{ action: "DEPOSIT", from: asset, to: share, venue: `Spark Savings ${SP_USDG}`, verified: true, source: this.src(ctx, "asset()") }],
        singleTransactionAvailable: { known: true, value: true, source: { ...this.src(ctx, "ERC-4626 deposit()"), type: "OFFICIAL_DOCS" } },
        note: null,
      },
      relationships: [],
      eligibility: null,
      contracts: [{ role: "vault", address: SP_USDG }],
      risk: {
        oracle: null,
        lltv: { known: false, reason: "not a lending market" },
        utilization: { known: false, reason: "savings vault" },
        availableLiquidityUsd: { known: false, reason: "withdrawal liquidity not read" },
        marketSizeUsd: tvl?.value.usd ? { known: true, value: tvl.value.usd, source: tvl.source } : { known: false, reason: "totalAssets or price unavailable" },
        rewardDependence: { known: true, value: 0n, source: this.src(ctx, "vsr()") },
        parameterMutability: { known: true, value: "the savings rate (vsr) and deposit cap are set by Spark governance and can change", source: { ...this.src(ctx, "docs"), type: "OFFICIAL_DOCS", url: CONFIG.docs ?? undefined } as DataSource },
        protocolListed: { known: false, reason: "no listing signal onchain" },
        protocolWarnings: [],
        allAssetsCanonical: true,
      },
      details: { kind: "ERC4626_SAVINGS", vault: SP_USDG, share, rateRay: vsr, totalAssets: tvl && tvl.value.amount ? { ...tvl, value: tvl.value.amount } : null, depositCap: cap === null ? null : { raw: cap, decimals: asset.decimals, display: formatFixed(cap, asset.decimals) } },
      provenance: [this.src(ctx, "vsr()"), this.src(ctx, "totalAssets()"), this.src(ctx, "asset()")],
      conflicts: [],
      warnings,
      freshness: fresh,
      verificationStatus: weakestStatus(["VERIFIED_ONCHAIN", tvl ? "VERIFIED_ONCHAIN" : "UNVERIFIED"]),
      observedAt,
      generatedAt: ctx.now().toISOString(),
    };
    return { data: [opp], status: tvl ? "COMPLETE" : "PARTIAL", issues: tvl ? [] : [{ scope: "spUSDG", message: "totalAssets unreadable", severity: "DEGRADED" }], warnings, timingsMs: { total: ms(t0) } };
  }

  async getUserPositions(wallet: Address, ctx: AdapterContext): Promise<AdapterResult<Position[]>> {
    const t0 = performance.now();
    const [bal] = await ctx.reader.multicall([{ address: SP_USDG, abi: savingsAbi, functionName: "balanceOf", args: [wallet] }], { blockNumber: ctx.blockNumber });
    if (bal?.status !== "success") return { data: [], status: "UNKNOWN", issues: [{ scope: "positions", message: "spUSDG balance unreadable", severity: "FATAL" }], warnings: [], timingsMs: { total: ms(t0) } };
    const shares = bal.result as bigint;
    if (shares === 0n) return { data: [], status: "COMPLETE", issues: [], warnings: [], timingsMs: { total: ms(t0) } };
    const [conv] = await ctx.reader.multicall([{ address: SP_USDG, abi: savingsAbi, functionName: "convertToAssets", args: [shares] }], { blockNumber: ctx.blockNumber });
    const opp = (await this.getOpportunities(ctx)).data[0];
    const asset = opp?.primaryAsset;
    const assets = conv?.status === "success" ? (conv.result as bigint) : null;
    const observedAt = new Date(Number(ctx.blockTimestamp) * 1000).toISOString();
    const fresh = classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), Math.floor(ctx.now().getTime() / 1000));
    const { priceOf } = asset ? await priceCanonicalAssets(ctx, [asset.key]) : { priceOf: () => ({ price: null }) };
    const px = asset ? priceOf(asset.key).price : null;
    const usd = asset && assets !== null && px ? usdValueE18(assets, asset.decimals, px.raw, px.decimals) : null;
    const pos: Position = {
      id: `${ctx.chainId}:${PROTOCOL.id}:position:${SP_USDG.toLowerCase()}`,
      chainId: ctx.chainId,
      protocol: { ...PROTOCOL },
      kind: "VAULT",
      venue: { kind: "ERC4626_SAVINGS", id: SP_USDG.toLowerCase(), address: SP_USDG },
      relatedOpportunityIds: opp ? [opp.id] : [],
      assets: asset ? [asset] : [],
      supplied:
        asset && assets !== null
          ? { value: { asset, amount: { raw: assets, decimals: asset.decimals, display: formatFixed(assets, asset.decimals) }, usd: usd === null ? null : { e18: usd, display: formatFixed(usd, USD_DECIMALS) } }, origin: "COMPUTED", source: this.src(ctx, "convertToAssets(balanceOf(user))"), observedAt, freshness: fresh, verification: "VERIFIED_ONCHAIN" }
          : null,
      borrowed: null,
      collateral: null,
      shares: { value: shares, origin: "SUPPLIED", source: this.src(ctx, "balanceOf(user)"), observedAt, freshness: fresh, verification: "VERIFIED_ONCHAIN" },
      healthFactor: null,
      ltv: null,
      liquidatable: null,
      provenance: [this.src(ctx, "balanceOf(user)")],
      conflicts: [],
      warnings: [],
      freshness: fresh,
      verificationStatus: "VERIFIED_ONCHAIN",
    };
    return { data: [pos], status: "COMPLETE", issues: [], warnings: [], timingsMs: { total: ms(t0) } };
  }
}
