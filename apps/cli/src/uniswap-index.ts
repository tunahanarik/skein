/**
 * Developer/operator tool (read-only): run the resumable Uniswap v3 pool-event scan to completion
 * and persist it to .cache/ (not committed). Normal runs advance the same scan within a small
 * budget; this command finishes it in one go (useful on the rate-limited public RPC).
 *
 *   pnpm uniswap:index [--budget-ms 600000]
 */
import { createRuntime, UNISWAP_POOL_CACHE_PATH } from "@skein/runtime/runtime";
import { OpportunityEngine } from "@skein/engine/opportunities/engine";
import { UniswapAdapter } from "@skein/protocols/uniswap/adapter";
import { FilePoolListStore } from "@skein/protocols/uniswap/poolStore";

const i = process.argv.indexOf("--budget-ms");
const budget = i >= 0 ? Number(process.argv[i + 1]) : 10 * 60_000;
if (!Number.isInteger(budget) || budget <= 0) throw new Error("--budget-ms must be a positive integer");

const rt = createRuntime();
const store = new FilePoolListStore(UNISWAP_POOL_CACHE_PATH);
const uni = new UniswapAdapter({ store, scanBudgetMs: budget });
const engine = new OpportunityEngine([uni], { reader: rt.reader, getRegistry: rt.getRegistry, prices: rt.prices });
const t = performance.now();
const r = await engine.getOpportunities({ eligibility: "ALL" });
const s = store.load();
console.log(`status ${r.status}; ${r.data.length / 2} markets; event pools persisted ${s?.pools.length ?? 0}; scan ${s?.coldScan ? `${s.coldScan.pending.length} tasks pending` : `complete to block ${s?.scannedTo}`}; tasks run ${uni.stats.coldTasksRun ?? 0}, splits ${uni.stats.taskSplits ?? 0}; ${Math.round(performance.now() - t)} ms`);
console.log(`rpc ${JSON.stringify(rt.reader.health())}`);
