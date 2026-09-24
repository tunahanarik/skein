/** Offline AssetIntelligenceService over the three-protocol fixture world. */
import { OpportunityEngine } from "../../src/opportunities/engine.js";
import type { OpportunityAdapter } from "../../src/opportunities/adapter.js";
import { getPortfolio } from "../../src/portfolio/engine.js";
import { AssetIntelligenceService } from "../../src/product/service.js";
import { MorphoAdapter } from "../../src/protocols/morpho/adapter.js";
import { PendleAdapter } from "../../src/protocols/pendle/adapter.js";
import { UniswapAdapter } from "../../src/protocols/uniswap/adapter.js";
import { MemoryPoolListStore } from "../../src/protocols/uniswap/poolStore.js";
import { FakeMorphoApi, fixtureMarkets, installMorpho } from "./morpho.js";
import { FakePendleApi, fixturePendleMarkets, installPendle } from "./pendle.js";
import { fixtureUniswapPools, installUniswap, type FixturePool } from "./uniswap.js";
import { defaultWorld, NOW, testStack } from "./world.js";

export type Protocol = "morpho" | "pendle" | "uniswap";

export async function intelligenceStack(opts: { failing?: Protocol[]; clock?: { t: number }; mutateWorld?: (w: ReturnType<typeof defaultWorld>) => void; mutatePools?: (p: Record<string, FixturePool>) => void; pendleBalances?: Parameters<typeof installPendle>[2] } = {}) {
  const world = defaultWorld();
  const pools = fixtureUniswapPools();
  opts.mutatePools?.(pools);
  installUniswap(world, pools);
  const mm = fixtureMarkets();
  const pm = fixturePendleMarkets();
  installMorpho(world, mm);
  installPendle(world, pm, opts.pendleBalances ?? {});
  opts.mutateWorld?.(world);
  const s = await testStack({ world });
  const clock = opts.clock ?? { t: NOW.getTime() };
  const now = () => new Date(clock.t);
  const failing = new Set(opts.failing ?? []);
  // Same adapter, but its discovery throws (controlled outage).
  const fail = (a: OpportunityAdapter): OpportunityAdapter => Object.assign(Object.create(a) as OpportunityAdapter, { getOpportunities: async () => { throw new Error(`${a.protocol.id} down (fixture)`); } });
  const adapters: OpportunityAdapter[] = [
    new MorphoAdapter(s.http, { api: new FakeMorphoApi(Object.values(mm).map((m) => m.apiRaw)), now: () => clock.t }),
    new PendleAdapter(s.http, { api: new FakePendleApi(pm), now: () => clock.t }),
    new UniswapAdapter({ store: new MemoryPoolListStore(), now: () => clock.t }),
  ].map((a) => (failing.has(a.protocol.id as Protocol) ? fail(a) : a));
  const engine = new OpportunityEngine(adapters, { reader: s.reader, getRegistry: async () => s.registry, prices: s.prices, now });
  let portfolioCalls = 0;
  const service = new AssetIntelligenceService({
    engine,
    getPortfolio: async (w) => {
      portfolioCalls++;
      return getPortfolio(w, { ...s.deps, now });
    },
    now,
  });
  return { s, world, pools, mm, pm, engine, service, clock, portfolioCalls: () => portfolioCalls };
}
