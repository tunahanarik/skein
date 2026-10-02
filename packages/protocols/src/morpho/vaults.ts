/**
 * Morpho Vault V2 → VAULT opportunities (pure). A vault is published only if the official
 * VaultV2Factory confirms it onchain (`isVaultV2`). totalAssets comes from the vault contract;
 * APY/liquidity/fees/warnings from the Morpho API. The API gives vault figures without a state
 * timestamp, so their freshness is UNKNOWN rather than assumed fresh.
 */
import type { Address } from "viem";
import { classifyFreshness, PROTOCOL_TOTALS_CONFLICT_PCT } from "@skein/core/config/freshness";
import { fixed18FromNumber, ratio18 } from "@skein/core/lib/fixed";
import { formatFixed, usdValueE18, USD_DECIMALS } from "@skein/core/lib/units";
import { opportunityId, type AmountWithUsd, type DataConflict, type Measured, type Opportunity, type YieldMetric } from "@skein/core/model/opportunity";
import type { DataSource } from "@skein/core/model/provenance";
import { weakestStatus } from "@skein/core/model/verification";
import { warn, type Warning } from "@skein/core/model/warnings";
import { worstFreshness } from "@skein/engine/opportunities/adapter";
import { openEndedLifecycle } from "@skein/engine/opportunities/lifecycle";
import { MORPHO_API_URL, type ApiVault } from "./api.js";
import type { NormalizeContext } from "./normalize.js";
import { PROTOCOL } from "./normalize.js";
import { sanitizeLabel } from "@skein/core/lib/sanitize";

// morpho-org/sdks addresses.ts (RobinhoodMainnet.vaultV2Factory), verified onchain in Phase 0.
export const VAULT_V2_FACTORY: Address = "0x0FBad98595b0186dA120E41f77C102beb49f803c";

export interface VaultInput {
  api: ApiVault;
  isOfficialVault: boolean | null; // factory.isVaultV2(vault); null = unreadable
  totalAssets: bigint | null; // onchain
}

export function normalizeVault(input: VaultInput, ctx: NormalizeContext): { opportunity: Opportunity | null; warnings: Warning[] } {
  const v = { ...input.api, name: sanitizeLabel(input.api.name) };
  const warnings: Warning[] = [];
  const short = `${v.address.slice(0, 10)}…`;
  if (input.isOfficialVault !== true) {
    return { opportunity: null, warnings: [warn("MARKET_UNVERIFIED_ONCHAIN", `vault ${short}: ${input.isOfficialVault === false ? "not created by the official VaultV2Factory" : "factory check unreadable"}; not published`)] };
  }
  const asset = ctx.resolveAsset(v.asset.address, v.asset.symbol, v.asset.decimals);
  if (!asset.canonical) warnings.push(warn(ctx.isLookalike(asset) ? "LOOKALIKE_TOKEN" : "NON_CANONICAL_ASSET", `vault ${short}: asset ${asset.symbol} ${asset.address} is not canonical`, { assetKey: asset.key }));
  const apiSrc: DataSource = { type: "OFFICIAL_API", provider: "morpho-api", url: MORPHO_API_URL, chainId: ctx.chainId, method: `vaultV2s.items[${short}]`, observedAt: ctx.apiFetchedAt };
  const chainSrc: DataSource = { type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract: v.address, method: "totalAssets()", blockNumber: ctx.blockNumber, observedAt: ctx.generatedAt };
  const factorySrc: DataSource = { ...chainSrc, contract: VAULT_V2_FACTORY, method: "isVaultV2(vault)" };
  const blockFresh = classifyFreshness("ONCHAIN_STATE", Number(ctx.blockTimestamp), ctx.nowS);
  const noTs = classifyFreshness("PROTOCOL_API_MARKET_STATE", null, ctx.nowS); // UNKNOWN: API gives no vault state time
  const px = ctx.priceOf(asset.key);
  const amt = (raw: bigint): AmountWithUsd => {
    const usd = px.price ? usdValueE18(raw, asset.decimals, px.price.raw, px.price.decimals) : null;
    return { asset, amount: { raw, decimals: asset.decimals, display: formatFixed(raw, asset.decimals) }, usd: usd === null ? null : { e18: usd, display: formatFixed(usd, USD_DECIMALS) } };
  };
  const conflicts: DataConflict[] = [];
  if (input.totalAssets !== null && v.totalAssets !== null) {
    const a = v.totalAssets;
    const c = input.totalAssets;
    const base = a > c ? a : c;
    if (base > 0n && ((a > c ? a - c : c - a) * 10_000n) / base > BigInt(PROTOCOL_TOTALS_CONFLICT_PCT * 100)) {
      conflicts.push({ field: "totalAssets", values: [{ value: a.toString(), source: apiSrc }, { value: c.toString(), source: chainSrc }], resolution: "onchain value used" });
      warnings.push(warn("DATA_CONFLICT", `vault ${short}: totalAssets API=${a} chain=${c}; onchain value used`));
    }
  }
  const tvl: Measured<AmountWithUsd> | null = input.totalAssets !== null ? { value: amt(input.totalAssets), origin: "SUPPLIED", source: chainSrc, observedAt: new Date(Number(ctx.blockTimestamp) * 1000).toISOString(), freshness: blockFresh, verification: "VERIFIED_ONCHAIN" } : null;
  if (!tvl) warnings.push(warn("MARKET_UNVERIFIED_ONCHAIN", `vault ${short}: totalAssets() unreadable`));
  const liquidity: Measured<AmountWithUsd> | null = v.liquidity !== null ? { value: amt(v.liquidity), origin: "SUPPLIED", source: { ...apiSrc, method: `${apiSrc.method}.liquidity` }, observedAt: ctx.apiFetchedAt, freshness: noTs, verification: "VERIFIED_OFFICIAL_API" } : null;
  const ym = (type: YieldMetric["type"], val: number | null, field: string, label: string): YieldMetric[] =>
    val === null
      ? []
      : [{ type, side: "EARN", basis: "VARIABLE", compounding: "COMPOUNDED", window: "protocol-defined", denominatedIn: asset, label, value: fixed18FromNumber(val), origin: "SUPPLIED", source: { ...apiSrc, method: `${apiSrc.method}.${field}` }, observedAt: ctx.apiFetchedAt, freshness: noTs, verification: "VERIFIED_OFFICIAL_API" }];
  const yields = [...ym("NET_APY", v.netApy, "netApy", "Morpho vault net APY (after fees, incl. rewards)"), ...ym("BASE_APY", v.netApyExcludingRewards, "netApyExcludingRewards", "Morpho vault net APY excluding rewards")];
  for (const w of v.warnings) warnings.push(warn("PROTOCOL_WARNING", `vault ${short}: Morpho reports ${w.type} (${w.level})`, { details: { type: w.type, level: w.level } }));
  if (v.listed === false) warnings.push(warn("UNLISTED_MARKET", `vault ${short}: not listed by Morpho`));
  const net = yields.find((y) => y.type === "NET_APY");
  const base = yields.find((y) => y.type === "BASE_APY");
  const opportunity: Opportunity = {
    id: opportunityId(ctx.chainId, PROTOCOL.id, "VAULT", "vault-v2", v.address),
    chainId: ctx.chainId,
    protocol: { ...PROTOCOL },
    category: "VAULT",
    title: `Deposit ${asset.symbol} into Morpho vault "${v.name.slice(0, 60)}"`,
    venue: { kind: "MORPHO_VAULT_V2", id: v.address.toLowerCase(), address: v.address },
    primaryAsset: asset,
    inputAssets: [asset],
    outputAssets: [asset],
    collateralAssets: [],
    borrowAssets: [],
    yields,
    tvl,
    availableLiquidity: liquidity,
    liquidityKind: "INSTANT_WITHDRAWAL",
    utilization: null,
    liquidation: null,
    term: { maturity: null, lockSeconds: null, withdrawal: "INSTANT_SUBJECT_TO_LIQUIDITY" },
    // A protocol-reported deposit_disabled warning closes entry (the vault stays discoverable).
    lifecycle: openEndedLifecycle({ number: ctx.blockNumber, timestamp: ctx.blockTimestamp }, v.warnings.some((w) => w.type === "deposit_disabled") ? ["DEPOSIT_DISABLED"] : []),
    entry: {
      kind: "DIRECT",
      requiredAsset: asset,
      steps: [{ action: "DEPOSIT", from: asset, to: null, venue: `Morpho Vault V2 ${v.address}`, verified: input.isOfficialVault === true, source: factorySrc }],
      singleTransactionAvailable: { known: true, value: true, source: { ...factorySrc, type: "OFFICIAL_DOCS", method: "ERC-4626 deposit()" } },
      note: null,
    },
    relationships: [],
    eligibility: null,
    contracts: [{ role: "vault", address: v.address }, { role: "factory", address: VAULT_V2_FACTORY }],
    risk: {
      oracle: null,
      lltv: { known: false, reason: "not a lending market" },
      utilization: { known: false, reason: "vault allocates across markets" },
      availableLiquidityUsd: liquidity?.value.usd ? { known: true, value: liquidity.value.usd, source: liquidity.source } : { known: false, reason: "liquidity or price unavailable" },
      marketSizeUsd: tvl?.value.usd ? { known: true, value: tvl.value.usd, source: chainSrc } : { known: false, reason: "totalAssets or price unavailable" },
      rewardDependence: net && base && net.value > 0n ? { known: true, value: ratio18(net.value > base.value ? net.value - base.value : 0n, net.value)!, source: apiSrc } : { known: false, reason: "APY breakdown unavailable" },
      parameterMutability: { known: false, reason: "vault governance (curator/allocator roles, caps, timelocks) not verified in Phase 2" },
      protocolListed: v.listed === null ? { known: false, reason: "API did not report listing" } : { known: true, value: v.listed, source: apiSrc },
      protocolWarnings: v.warnings,
      allAssetsCanonical: asset.canonical,
    },
    details: {
      kind: "MORPHO_VAULT_V2",
      vault: v.address,
      name: v.name.slice(0, 120),
      curator: v.curator?.address ?? null,
      totalAssets: tvl && tvl.value.amount
        ? { ...tvl, value: tvl.value.amount }
        : v.totalAssets !== null
          ? { value: { raw: v.totalAssets, decimals: asset.decimals, display: formatFixed(v.totalAssets, asset.decimals) }, origin: "SUPPLIED", source: apiSrc, observedAt: ctx.apiFetchedAt, freshness: noTs, verification: "VERIFIED_OFFICIAL_API" }
          : null,
      performanceFee: v.performanceFee === null ? null : fixed18FromNumber(v.performanceFee),
      managementFee: v.managementFee === null ? null : fixed18FromNumber(v.managementFee),
    },
    provenance: [factorySrc, chainSrc, apiSrc],
    conflicts,
    warnings,
    freshness: worstFreshness([blockFresh, ...yields.map((y) => y.freshness)], blockFresh),
    verificationStatus: conflicts.length ? "CONFLICT" : weakestStatus([asset.canonical ? "VERIFIED_ONCHAIN" : "UNVERIFIED", tvl ? "VERIFIED_ONCHAIN" : "UNVERIFIED", ...yields.map((y) => y.verification)]),
    observedAt: new Date(Number(ctx.blockTimestamp) * 1000).toISOString(),
    generatedAt: ctx.generatedAt,
  };
  return { opportunity, warnings };
}
