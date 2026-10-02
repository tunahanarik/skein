/** Offline AssetIntelligenceService over the three-protocol fixture world. */
import { OpportunityEngine } from "@skein/engine/opportunities/engine";
import type { OpportunityAdapter } from "@skein/engine/opportunities/adapter";
import { getPortfolio } from "@skein/portfolio/engine";
import { AssetIntelligenceService } from "@skein/product/service";
import { MorphoAdapter } from "@skein/protocols/morpho/adapter";
import { PendleAdapter } from "@skein/protocols/pendle/adapter";
import { UniswapAdapter } from "@skein/protocols/uniswap/adapter";
import { MemoryPoolListStore } from "@skein/protocols/uniswap/poolStore";
import { FakeMorphoApi, fixtureMarkets, installMorpho } from "./morpho.js";
import { FakePendleApi, fixturePendleMarkets, installPendle } from "./pendle.js";
import { fixtureUniswapPools, installUniswap, type FixturePool } from "./uniswap.js";
import type { VolumeSource } from "@skein/robinhood/sources/geckoterminal";
import { defaultWorld, NOW, testStack } from "./world.js";

export type Protocol = "morpho" | "pendle" | "uniswap";

export async function intelligenceStack(opts: { failing?: Protocol[]; clock?: { t: number }; mutateWorld?: (w: ReturnType<typeof defaultWorld>) => void; mutatePools?: (p: Record<string, FixturePool>) => void; pendleBalances?: Parameters<typeof installPendle>[2]; maxStaleMs?: number; volumes?: VolumeSource } = {}) {
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
    prices: s.prices,
    ...(opts.volumes ? { volumes: opts.volumes } : {}),
    ...(opts.maxStaleMs !== undefined ? { maxStaleMs: opts.maxStaleMs } : {}),
  });
  return { s, world, pools, mm, pm, engine, service, clock, portfolioCalls: () => portfolioCalls };
}
