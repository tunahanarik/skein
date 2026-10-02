/** Beefy CLM adapter: API candidates are published only after onchain identity checks. */
import { describe, expect, it } from "vitest";
import { OpportunityEngine } from "@skein/engine/opportunities/engine";
import { BeefyAdapter, type BeefyApi, type CowVault } from "../src/beefy/adapter.js";
import { fixtureUniswapPools, installUniswap } from "@skein/testkit/uniswap";
import { defaultWorld, NVDA, ONE, testStack, USDG } from "@skein/testkit/world";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const CLM = addr(0xb001);
const STRAT = addr(0xb002);
const ROGUE_POOL = addr(0xb003);

function api(vaults: Partial<CowVault>[], apy = 0.12): BeefyApi {
  const at = new Date("2026-09-24T12:00:00Z").toISOString();
  return {
    cowVaults: async () => ({ data: vaults.map((v) => ({ id: "uniswap-cow-robinhood-nvda-usdg", chain: "robinhood", status: "active", tokenProviderId: "uniswap", earnContractAddress: CLM, depositTokenAddresses: [NVDA, USDG], ...v }) as CowVault), fetchedAt: at }),
    apy: async () => ({ data: new Map([["uniswap-cow-robinhood-nvda-usdg", { totalApy: apy, clmApr: apy, fee: 0.095 }]]), fetchedAt: at }),
  };
}

async function run(opts: { pool?: `0x${string}`; wants?: [string, string] } = {}) {
  const w = defaultWorld();
  const pools = fixtureUniswapPools();
  installUniswap(w, pools);
  const contracts = (w.contracts ??= new Map());
  contracts.set(CLM.toLowerCase(), { wants: opts.wants ?? [NVDA, USDG], balances: [10n * ONE, 2_244_000_000n], strategy: STRAT });
  contracts.set(STRAT.toLowerCase(), { pool: opts.pool ?? pools.nvdaUsdg!.pool });
  contracts.set(ROGUE_POOL.toLowerCase(), { factory: addr(0xfac7), fee: 500, token0: NVDA, token1: USDG });
  const s = await testStack({ world: w });
  const engine = new OpportunityEngine([new BeefyAdapter(s.http, { api: api([{}]) })], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now });
  return engine.getOpportunities({ eligibility: "ALL" });
}

describe("Beefy CLM adapter", () => {
  it("publishes one LP opportunity per canonical token, TVL from onchain balances", async () => {
    const r = await run();
    expect(r.status).toBe("COMPLETE");
    expect(r.data.map((o) => o.primaryAsset.symbol).sort()).toEqual(["NVDA", "USDG"]);
    const o = r.data.find((x) => x.primaryAsset.symbol === "NVDA")!;
    expect(o.category).toBe("LP");
    expect(o.tvl?.verification).toBe("VERIFIED_ONCHAIN");
    expect(Number(o.tvl!.value.usd!.display)).toBeGreaterThan(4000); // 10 NVDA + 2,244 USDG
    expect(Number(o.yields[0]!.value) / 1e16).toBeCloseTo(12, 6);
    expect(o.entry.note).toMatch(/both/);
  });

  it("refuses a CLM whose pool is not an official Uniswap v3 pool", async () => {
    const r = await run({ pool: ROGUE_POOL });
    expect(r.data).toEqual([]);
    expect(r.warnings.some((w) => w.code === "MARKET_UNVERIFIED_ONCHAIN")).toBe(true);
  });

  it("refuses a CLM whose onchain tokens differ from the API", async () => {
    const r = await run({ wants: [NVDA, addr(0xbad1)] });
    expect(r.data).toEqual([]);
  });
});
