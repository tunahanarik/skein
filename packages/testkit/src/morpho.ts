/**
 * Offline Morpho world for Phase 2 tests: a fake Morpho API + onchain state layered on the
 * Phase 1 fixture world (packages/testkit/src/world.ts). All numbers are deterministic.
 */
import { getAddress, type Address } from "viem";
import { apiMarketSchema, apiVaultSchema, type ApiMarket, type ApiVault, type MorphoApi, type ParsedPage } from "@skein/protocols/morpho/api";
import { expectedOraclePrice } from "@skein/protocols/morpho/oracleCheck";
import { marketIdOf, type MarketParams } from "@skein/protocols/morpho/onchain";
import { AAPL, NOW, NOW_S, NVDA, NVDA_MULT, ONE, USDG, type WorldState } from "./world.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
export const IRM = addr(0x1a1);
export const ORACLE_OK = addr(0x0c1);
export const ORACLE_DOUBLE = addr(0x0c2);
export const ORACLE_FAKE = addr(0x0c3);
export const ORACLE_REVERTS = addr(0x0c4);
export const FAKE_NVDA = addr(0xbad2); // non-canonical token whose API symbol is "NVDA"
export const VAULT_OK = addr(0x7a1);
export const VAULT_ROGUE = addr(0x7a2);
export const ZERO: Address = "0x0000000000000000000000000000000000000000";

export const LLTV_625 = 625n * 10n ** 15n;
export const LLTV_77 = 77n * 10n ** 16n;

/** Correct NVDA/USDG oracle price from the fixture Chainlink answers (NVDA 224.41382169, USDG 1.00009). */
export const NVDA_USDG_ORACLE = expectedOraclePrice({ raw: 22_441_382_169n, decimals: 8 }, { raw: 100_009_000n, decimals: 8 }, 18, 6)!;
export const NVDA_USDG_ORACLE_DOUBLE = (NVDA_USDG_ORACLE * NVDA_MULT) / ONE;

export interface FixtureMarket {
  params: MarketParams;
  totals: { supply: bigint; supplyShares: bigint; borrow: bigint; borrowShares: bigint };
  /** Raw API JSON (validated by the real schema in `api.markets`). */
  apiRaw: Record<string, unknown>;
}

function market(params: MarketParams, totals: FixtureMarket["totals"], api: { loanSym: string; collSym: string | null; loanDec?: number; collDec?: number; state?: Record<string, unknown> | null; listed?: boolean; overrides?: Record<string, unknown> }): FixtureMarket {
  const id = marketIdOf(params);
  return {
    params,
    totals,
    apiRaw: {
      marketId: id,
      listed: api.listed ?? true,
      lltv: params.lltv.toString(),
      irmAddress: params.irm,
      loanAsset: { address: params.loanToken, symbol: api.loanSym, decimals: api.loanDec ?? 6 },
      collateralAsset: api.collSym === null ? null : { address: params.collateralToken, symbol: api.collSym, decimals: api.collDec ?? 18 },
      oracle: { address: params.oracle, type: "ChainlinkOracleV2" },
      warnings: [],
      state:
        api.state === null
          ? null
          : {
              blockNumber: 70_999_000,
              timestamp: NOW_S - 600,
              supplyAssets: Number(totals.supply),
              borrowAssets: Number(totals.borrow),
              collateralAssets: "5000000000000000000",
              liquidityAssets: Number(totals.supply - totals.borrow),
              supplyApy: 0.0409,
              borrowApy: 0.04538947,
              netSupplyApy: 0.0509,
              netBorrowApy: 0.04,
              utilization: 0.9,
              fee: 0,
              rewards: [{ asset: { address: USDG, symbol: "USDG" }, supplyApr: 0.01, borrowApr: 0.005 }],
              ...(api.state ?? {}),
            },
      ...(api.overrides ?? {}),
    },
  };
}

export function fixtureMarkets() {
  return {
    // NVDA collateral / USDG loan, correct oracle
    nvdaOk: market({ loanToken: USDG, collateralToken: NVDA, oracle: ORACLE_OK, irm: IRM, lltv: LLTV_625 }, { supply: 100_000_000_000n, supplyShares: 100_000_000_000_000_000n, borrow: 60_000_000_000n, borrowShares: 60_000_000_000_000_000n }, { loanSym: "USDG", collSym: "NVDA" }),
    // same pair, oracle multiplies by uiMultiplier again
    nvdaDouble: market({ loanToken: USDG, collateralToken: NVDA, oracle: ORACLE_DOUBLE, irm: IRM, lltv: LLTV_625 }, { supply: 50_000_000_000n, supplyShares: 50_000_000_000_000_000n, borrow: 1_000_000n, borrowShares: 1_000_000_000_000n }, { loanSym: "USDG", collSym: "NVDA", listed: false }),
    // look-alike "NVDA" collateral
    fake: market({ loanToken: USDG, collateralToken: FAKE_NVDA, oracle: ORACLE_FAKE, irm: IRM, lltv: LLTV_77 }, { supply: 10_000_000n, supplyShares: 10_000_000_000_000n, borrow: 0n, borrowShares: 0n }, { loanSym: "USDG", collSym: "NVDA", listed: false }),
    // idle market: no collateral, no IRM
    idle: market({ loanToken: USDG, collateralToken: ZERO, oracle: ZERO, irm: ZERO, lltv: 0n }, { supply: 5n, supplyShares: 5_000_000n, borrow: 0n, borrowShares: 0n }, { loanSym: "USDG", collSym: null }),
    // 100 % utilized, AAPL collateral (oracle reverts)
    full: market({ loanToken: USDG, collateralToken: AAPL, oracle: ORACLE_REVERTS, irm: IRM, lltv: LLTV_625 }, { supply: 1_000_000n, supplyShares: 1_000_000_000_000n, borrow: 1_000_000n, borrowShares: 1_000_000_000_000n }, { loanSym: "USDG", collSym: "AAPL" }),
  };
}

export function vaultRaw(address: Address, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address,
    name,
    listed: true,
    asset: { address: USDG, symbol: "USDG", decimals: 6 },
    curator: { address: addr(0xc0ffee) },
    totalAssets: "150000000000",
    liquidity: "40000000000",
    apy: 0.0405,
    netApy: 0.0397,
    netApyExcludingRewards: 0.0297,
    performanceFee: 0,
    managementFee: 0,
    warnings: [{ type: "deposit_disabled", level: "RED" }],
    ...extra,
  };
}

/** Apply the fixture markets/vaults to a FakeChainReader world. */
export function installMorpho(world: WorldState, markets: Record<string, FixtureMarket>, opts: { oracleOverrides?: Record<string, bigint | "revert"> } = {}) {
  if (!world.balances.has(VAULT_OK.toLowerCase())) world.balances.set(VAULT_OK.toLowerCase(), new Map()); // vault share token exists
  const m = new Map<string, FixtureMarket>();
  for (const f of Object.values(markets)) m.set(marketIdOf(f.params).toLowerCase(), f);
  world.morpho = {
    markets: m,
    oracles: new Map<string, bigint | "revert">([
      [ORACLE_OK.toLowerCase(), NVDA_USDG_ORACLE],
      [ORACLE_DOUBLE.toLowerCase(), NVDA_USDG_ORACLE_DOUBLE],
      [ORACLE_FAKE.toLowerCase(), 10n ** 24n],
      [ORACLE_REVERTS.toLowerCase(), "revert"],
      ...Object.entries(opts.oracleOverrides ?? {}).map(([k, v]) => [k.toLowerCase(), v] as [string, bigint | "revert"]),
    ]),
    officialVaults: new Set([VAULT_OK.toLowerCase()]),
    vaultTotals: new Map([[VAULT_OK.toLowerCase(), 150_000_000_000n], [VAULT_ROGUE.toLowerCase(), 1n]]),
    positions: new Map(),
  };
}

export class FakeMorphoApi implements MorphoApi {
  calls = 0;
  fail: false | "markets" | "vaults" | "all" = false;
  constructor(
    public marketsRaw: unknown[],
    public vaultsRaw: unknown[] = [vaultRaw(VAULT_OK, "Steak USDG"), vaultRaw(VAULT_ROGUE, "Rogue USDG")],
  ) {}

  private page<T>(raw: unknown[], schema: { safeParse: (x: unknown) => { success: boolean; data?: T; error?: { message: string } } }): ParsedPage<T> {
    const items: T[] = [];
    const rejected: { index: number; error: string }[] = [];
    raw.forEach((r, i) => {
      const p = schema.safeParse(r);
      if (p.success) items.push(p.data as T);
      else rejected.push({ index: i, error: p.error!.message.slice(0, 80) });
    });
    return { items, rejected, countTotal: raw.length, fetchedAt: NOW.toISOString() };
  }

  async markets(): Promise<ParsedPage<ApiMarket>> {
    this.calls++;
    if (this.fail === "markets" || this.fail === "all") throw new Error("HTTP 503");
    return this.page<ApiMarket>(this.marketsRaw, apiMarketSchema as never);
  }

  async vaults(): Promise<ParsedPage<ApiVault>> {
    if (this.fail === "vaults" || this.fail === "all") throw new Error("HTTP 502");
    return this.page<ApiVault>(this.vaultsRaw, apiVaultSchema as never);
  }
}
