/**
 * Live validation (read-only): every trade pair shown in the app is re-read on-chain with raw
 * viem calls, independent of the adapters.
 *
 *   v3-style pools (Uniswap v3, Ramses CL)  pool.token0/token1/factory == the market's assets and
 *                                          the protocol's factory; token0 < token1
 *   Uniswap v4 (hookless)                   keccak256(PoolKey) == the market id, and
 *                                          StateView.getSlot0 is initialized
 *   every side of every pair               a canonical asset's symbol/decimals == the registry
 *
 * No wallet data is read or printed.
 */
import { createPublicClient, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { robinhoodChain } from "../src/config/chains.js";
import type { TradeMarket } from "../src/model/trade.js";
import { RAMSES_CL } from "../src/protocols/ramses/dialect.js";
import { UNISWAP_V3 } from "../src/protocols/uniswap/constants.js";
import { stateViewAbi } from "../src/protocols/uniswap/v4adapter.js";
import { UNISWAP_RECORDED_ONLY } from "../src/protocols/uniswap/constants.js";
import { hooklessKey, poolIdOf } from "../src/protocols/uniswap/v4math.js";
import { createRuntime } from "../src/runtime.js";
import { Report } from "./lib/report.js";

const poolAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function factory() view returns (address)"]);
const FACTORY: Record<string, Address> = { [UNISWAP_V3.protocol.id]: UNISWAP_V3.factory, [RAMSES_CL.protocol.id]: RAMSES_CL.factory };
const lc = (a: string) => a.toLowerCase();

export async function validatePairs(report = new Report("pairs-validation")) {
  const rt = createRuntime();
  const client = createPublicClient({ chain: robinhoodChain, transport: http(rt.rpc.url, { retryCount: 4, retryDelay: 1500, batch: false }) });
  await rt.reader.assertChainId();
  const registry = await rt.getRegistry();
  const markets = (await rt.opportunities.getTradeMarkets()).data;
  const byProto = markets.reduce<Record<string, number>>((m, x) => ((m[x.protocol.id] = (m[x.protocol.id] ?? 0) + 1), m), {});
  report.add("INFO", "markets", `${markets.length} trade markets: ${JSON.stringify(byProto)}`);

  // ---- symbols / decimals of every side vs the registry ----
  const sideBad: string[] = [];
  for (const m of markets)
    for (const a of m.assets) {
      const r = registry.get(4663, a.address);
      if (a.canonical && (!r || !r.canonical || r.symbol !== a.symbol || r.decimals !== a.decimals)) sideBad.push(`${m.id} ${a.symbol}`);
    }
  report.add(sideBad.length ? "FAIL" : "PASS", "pair sides vs registry", sideBad.length ? sideBad.slice(0, 10).join("; ") : `${markets.length * 2} sides: canonical symbol and decimals match`);

  // ---- v3-style pools ----
  const v3 = markets.filter((m) => m.address && FACTORY[m.protocol.id]);
  const reads = await client.multicall({
    allowFailure: true,
    contracts: v3.flatMap((m) => (["token0", "token1", "factory"] as const).map((fn) => ({ address: m.address!, abi: poolAbi, functionName: fn }))),
  });
  const v3Bad: string[] = [];
  v3.forEach((m, i) => {
    const [t0, t1, f] = reads.slice(i * 3, i * 3 + 3).map((r) => (r.status === "success" ? lc(r.result as string) : null));
    const label = `${m.protocol.id} ${m.assets[0].symbol}/${m.assets[1].symbol} ${m.address}`;
    if (t0 !== lc(m.assets[0].address) || t1 !== lc(m.assets[1].address)) v3Bad.push(`${label}: tokens ${t0}/${t1}`);
    else if (f !== lc(FACTORY[m.protocol.id]!)) v3Bad.push(`${label}: factory ${f}`);
    else if (BigInt(t0) >= BigInt(t1)) v3Bad.push(`${label}: token order`);
  });
  report.add(v3Bad.length ? "FAIL" : "PASS", "v3-style pools on-chain", v3Bad.length ? v3Bad.slice(0, 10).join("; ") : `${v3.length} pools: token0, token1 and factory match`);

  // ---- Uniswap v4 hookless ----
  const v4 = markets.filter((m) => m.protocol.id === "uniswap-v4");
  const v4Bad: string[] = [];
  const ids: Hex[] = [];
  for (const m of v4) {
    const d = m.details as { feePpm?: number; tickSpacing?: number };
    const id = poolIdOf(hooklessKey(getAddress(m.assets[0].address), getAddress(m.assets[1].address), d.feePpm ?? -1, d.tickSpacing ?? 0));
    ids.push(id);
    if (lc(id) !== lc(m.marketId)) v4Bad.push(`${m.assets[0].symbol}/${m.assets[1].symbol} ${m.marketId}: PoolKey id ${id}`);
  }
  const slots = await client.multicall({ allowFailure: true, contracts: ids.map((id) => ({ address: UNISWAP_RECORDED_ONLY.v4StateView, abi: stateViewAbi, functionName: "getSlot0" as const, args: [id] as const })) });
  slots.forEach((s, i) => {
    if (s.status !== "success" || (s.result as readonly [bigint, ...unknown[]])[0] === 0n) v4Bad.push(`${v4[i]!.assets[0].symbol}/${v4[i]!.assets[1].symbol}: not initialized`);
  });
  report.add(v4Bad.length ? "FAIL" : "PASS", "v4 pool ids on-chain", v4Bad.length ? v4Bad.slice(0, 10).join("; ") : `${v4.length} pools: PoolKey hash == market id, slot0 initialized`);

  const other = markets.filter((m) => !v3.includes(m) && !v4.includes(m));
  if (other.length) report.add("WARN", "unchecked markets", other.map((m: TradeMarket) => m.id).slice(0, 10).join("; "));
  return report;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("validate-pairs.ts")) {
  const r = await validatePairs();
  process.exit(r.finish());
}
