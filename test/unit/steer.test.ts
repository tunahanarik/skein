/** Steer v3 vaults: registry + official pool checks; v4 vaults skipped. */
import { describe, expect, it } from "vitest";
import { OpportunityEngine } from "../../src/opportunities/engine.js";
import { SteerAdapter, type SteerApi } from "../../src/protocols/steer/adapter.js";
import { fixtureUniswapPools, installUniswap } from "../fixtures/uniswap.js";
import { defaultWorld, NVDA, ONE, testStack, USDG } from "../fixtures/world.js";

const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const VAULT = addr(0x5e01);
const V4 = addr(0x5e02);
const REGISTRY = "0x5c7d564fa5ce0e874367121e33c1ff10db2115dc";

async function run(opts: { state?: number } = {}) {
  const w = defaultWorld();
  const pools = fixtureUniswapPools();
  installUniswap(w, pools);
  const p = pools.nvdaUsdg!;
  const c = (w.contracts ??= new Map());
  c.set(VAULT.toLowerCase(), { pool: p.pool, token0: p.token0, token1: p.token1, getTotalAmounts: [5n * ONE, 1_122_000_000n] });
  c.set(REGISTRY, { getVaultDetails: (a: readonly unknown[]) => ({ state: String(a[0]).toLowerCase() === VAULT.toLowerCase() ? (opts.state ?? 1) : 0, tokenId: 1n, vaultID: 1n, payloadIpfs: "", vaultAddress: a[0], beaconName: "MultiPositionUniswapV3" }) });
  const api: SteerApi = { vaults: async () => ({ data: [{ vaultAddress: VAULT, beaconName: "MultiPositionUniswapV3", apr: { apr: 19.94 } }, { vaultAddress: V4, beaconName: "MultiPositionUniswapV4NoOracle", apr: { apr: 486 } }], fetchedAt: new Date("2026-09-24T12:00:00Z").toISOString() }) };
  const s = await testStack({ world: w });
  return new OpportunityEngine([new SteerAdapter(s.http, { api })], { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now: s.now }).getOpportunities({ eligibility: "ALL" });
}

describe("Steer adapter", () => {
  it("publishes verified v3 vaults (one LP per canonical token) and skips v4", async () => {
    const r = await run();
    expect(r.data.map((o) => o.primaryAsset.symbol).sort()).toEqual(["NVDA", "USDG"]);
    const o = r.data[0]!;
    expect(o.yields[0]!.type).toBe("LP_APR");
    expect(Number(o.yields[0]!.value) / 1e16).toBeCloseTo(19.94, 6);
    expect(o.tvl?.verification).toBe("VERIFIED_ONCHAIN");
    expect(r.warnings.some((w) => /v4 vaults skipped/.test(w.message))).toBe(true);
    expect(r.data.some((x) => x.venue.id === V4.toLowerCase())).toBe(false);
  });
  it("refuses a vault the registry does not list as active", async () => {
    const r = await run({ state: 2 });
    expect(r.data).toEqual([]);
  });
});
