/**
 * Steer adapter → LP opportunities for Steer's managed Uniswap v3 vaults.
 *
 * Candidates and fee APR: the official Steer API (`getAprs?chainId=4663&dexName=uniswap`). Only v3
 * vaults (beacon "MultiPositionUniswapV3"); v4 vaults are skipped under the P4-1 decision (hooks).
 * Published only if, onchain at the block: the official VaultRegistry (@steerprotocol/sdk
 * deployments) knows the vault with state 1 (active) and the same beacon, vault.pool() is an
 * official Uniswap v3 pool, and vault.token0/token1 are that pool's tokens.
 * TVL: vault.getTotalAmounts() valued with the Phase 1 Price Service.
 */
import { parseAbi, type Address } from "viem";
import { z } from "zod";
import { CACHE_TTL_MS } from "../../config/freshness.js";
import { PROTOCOLS } from "../../config/protocols.js";
import { TtlCache } from "../../lib/cache.js";
import type { HttpClient } from "../../lib/http.js";
import type { Opportunity, OpportunityCategory } from "../../model/opportunity.js";
import type { DataSource } from "../../model/provenance.js";
import { warn, type Warning } from "../../model/warnings.js";
import type { AdapterCapabilities, AdapterContext, AdapterIssue, AdapterResult, OpportunityAdapter } from "../../opportunities/adapter.js";
import { managedLpOpportunities, same, verifyV3Pools, type ManagedLpInput } from "../shared/managedLp.js";

export const PROTOCOL = { id: "steer", name: "Steer" } as const;
export const STEER_APR_URL = "https://api.steer.finance/getAprs?chainId=4663&dexName=uniswap";
const REGISTRY = PROTOCOLS.find((p) => p.id === "steer")!.contracts.vaultRegistry! as Address;
const V3_BEACON = "MultiPositionUniswapV3";

const vaultSchema = z
  .object({
    vaultAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    beaconName: z.string().max(100),
    apr: z.object({ apr: z.number().finite().nullable().optional(), message: z.string().max(200).optional() }).passthrough().optional(),
  })
  .passthrough();
const aprSchema = z.object({ vaults: z.array(z.unknown()) }).transform((o) => o.vaults.flatMap((x) => {
  const r = vaultSchema.safeParse(x);
  return r.success ? [r.data] : [];
}));
export type SteerApiVault = z.infer<typeof vaultSchema>;

export interface SteerApi {
  vaults(): Promise<{ data: SteerApiVault[]; fetchedAt: string }>;
}

export class HttpSteerApi implements SteerApi {
  private readonly cache = new TtlCache<{ data: SteerApiVault[]; fetchedAt: string }>();
  constructor(private readonly http: HttpClient) {}
  vaults() {
    return this.cache.getOrLoad("aprs", CACHE_TTL_MS.PROTOCOL_MARKET_STATE, async () => {
      const r = await this.http.getJson(STEER_APR_URL, aprSchema, { maxBytes: 2_000_000 });
      return { data: r.data, fetchedAt: r.fetchedAt };
    });
  }
}

export const steerAbi = parseAbi([
  "function pool() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getTotalAmounts() view returns (uint256, uint256)",
  "function getVaultDetails(address) view returns ((uint8 state, uint256 tokenId, uint256 vaultID, string payloadIpfs, address vaultAddress, string beaconName))",
]);

const ms = (t: number) => Math.round(performance.now() - t);

export class SteerAdapter implements OpportunityAdapter {
  readonly protocol = { ...PROTOCOL };
  readonly categories: readonly OpportunityCategory[] = ["LP"];
  readonly capabilities: AdapterCapabilities = { discovery: true, assetFiltering: false, userPositions: false, singleOpportunity: false, execution: false };
  private readonly api: SteerApi;

  constructor(http: HttpClient, opts: { api?: SteerApi } = {}) {
    this.api = opts.api ?? new HttpSteerApi(http);
  }

  supportsCategory(c: OpportunityCategory): boolean {
    return this.categories.includes(c);
  }

  async getOpportunities(ctx: AdapterContext): Promise<AdapterResult<Opportunity[]>> {
    const t0 = performance.now();
    const issues: AdapterIssue[] = [];
    const warnings: Warning[] = [];
    let api: { data: SteerApiVault[]; fetchedAt: string };
    try {
      api = await this.api.vaults();
    } catch (e) {
      return { data: [], status: "UNKNOWN", issues: [{ scope: "steer-api", message: (e as Error).message, severity: "FATAL" }], warnings, timingsMs: { total: ms(t0) } };
    }
    const skippedV4 = api.data.filter((v) => v.beaconName !== V3_BEACON).length;
    const vaults = api.data.filter((v) => v.beaconName === V3_BEACON);
    if (skippedV4) warnings.push(warn("PROTOCOL_WARNING", `Steer: ${skippedV4} Uniswap v4 vaults skipped (v4 not integrated, decision P4-1)`));
    if (!vaults.length) return { data: [], status: "COMPLETE", issues, warnings, timingsMs: { total: ms(t0) } };

    const b = { blockNumber: ctx.blockNumber };
    const r = await ctx.reader.multicall(
      vaults.flatMap((v) => [
        { address: v.vaultAddress as Address, abi: steerAbi, functionName: "pool" },
        { address: v.vaultAddress as Address, abi: steerAbi, functionName: "token0" },
        { address: v.vaultAddress as Address, abi: steerAbi, functionName: "token1" },
        { address: v.vaultAddress as Address, abi: steerAbi, functionName: "getTotalAmounts" },
        { address: REGISTRY, abi: steerAbi, functionName: "getVaultDetails", args: [v.vaultAddress] },
      ]),
      b,
    );
    const val = <T>(i: number, k: number): T | null => (r[i * 5 + k]?.status === "success" ? (r[i * 5 + k] as { result: T }).result : null);
    const pools = vaults.map((_, i) => val<Address>(i, 0));
    const info = await verifyV3Pools(ctx, pools);
    const chain = (contract: Address, method: string): DataSource => ({ type: "ONCHAIN", provider: "robinhood-chain-rpc", chainId: ctx.chainId, contract, method, blockNumber: ctx.blockNumber, observedAt: ctx.now().toISOString() });

    const inputs: ManagedLpInput[] = [];
    vaults.forEach((v, i) => {
      const t0a = val<Address>(i, 1);
      const t1a = val<Address>(i, 2);
      const amounts = val<readonly [bigint, bigint]>(i, 3);
      const d = val<{ state: number; vaultAddress: Address; beaconName: string }>(i, 4);
      const p = info[i];
      const short = `${v.vaultAddress.slice(0, 10)}…`;
      const registered = !!d && Number(d.state) === 1 && same(d.vaultAddress, v.vaultAddress) && d.beaconName === V3_BEACON;
      const poolMatch = !!p && !!t0a && !!t1a && same(p.token0, t0a) && same(p.token1, t1a);
      if (!registered || !poolMatch || !amounts) {
        warnings.push(warn("MARKET_UNVERIFIED_ONCHAIN", `Steer vault ${short}: ${!registered ? "not an active vault in the official VaultRegistry" : !poolMatch ? "pool is not an official Uniswap v3 pool of the vault's tokens" : "getTotalAmounts unreadable"}; not published`));
        return;
      }
      const src: DataSource = { type: "OFFICIAL_API", provider: "steer-api", url: STEER_APR_URL, chainId: ctx.chainId, method: `vaults[${v.vaultAddress.slice(0, 12)}].apr`, observedAt: api.fetchedAt };
      const aprPct = v.apr?.apr ?? null;
      inputs.push({
        protocol: PROTOCOL,
        manager: "STEER",
        managerLabel: "Steer vault",
        vault: v.vaultAddress as Address,
        pool: pools[i]!,
        feePpm: p!.fee,
        tokens: [t0a!, t1a!],
        amounts: [amounts[0], amounts[1]],
        amountsMethod: "getTotalAmounts()",
        rate: aprPct !== null ? { type: "LP_APR", value: aprPct / 100, label: "Steer vault fee APR (Steer API)", compounding: "SIMPLE", source: src, fetchedAt: api.fetchedAt } : null,
        apiId: v.vaultAddress,
        identitySources: [chain(REGISTRY, "getVaultDetails(vault)"), chain(v.vaultAddress as Address, "pool()"), chain(pools[i]!, "factory()")],
        protocolWarnings: [],
        extraWarnings: [],
        entryNote: "Deposits take both {pair} tokens in the vault's current ratio. The vault manages several Uniswap v3 ranges; its token mix changes with price (impermanent loss).",
        mutability: "Steer strategies move the vault's Uniswap v3 positions automatically",
      });
    });
    if (inputs.length < vaults.length) issues.push({ scope: "steer:identity", message: `${vaults.length - inputs.length} vaults failed onchain checks`, severity: "DEGRADED" });
    const out = await managedLpOpportunities(ctx, inputs);
    return { data: out, status: issues.length ? "PARTIAL" : "COMPLETE", issues, warnings, timingsMs: { total: ms(t0) } };
  }
}
