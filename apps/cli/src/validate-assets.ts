/**
 * Asset registry checks:
 *  1. Robinhood's official Stock Token list parses and every listed Chain-4663 token agrees
 *     with its own contract (symbol, decimals, uid, uiMultiplier, beacon registry).
 *  2. The sample tokens (NVDA, AAPL, TSLA, GOOGL) resolve to canonical addresses.
 *  3. WETH and USDG metadata and proxy wiring.
 * Read-only.
 */
import { getAddress, type Address, type Hex } from "viem";
import { EIP1967_SLOTS, erc20Abi, stockTokenAbi } from "@skein/core/config/abis";
import { ROBINHOOD_CHAIN_ID } from "@skein/networks/chains";
import { parseMultiplier } from "@skein/core/lib/stockToken";
import { sameAddress } from "@skein/core/lib/validation";
import { canonicalStockTokens, rhjAssetsResponseSchema, RHJ_BASE_URL } from "@skein/robinhood/sources/robinhood";
import { getJson, makeClient } from "./lib/rpc.js";
import { Report } from "./lib/report.js";

const STOCK_REGISTRY = "0xe10b6f6b275de231345c20d14ab812db62151b00"; // beacon, see stock-tokens.md
const SAMPLE_SYMBOLS = ["NVDA", "AAPL", "TSLA", "GOOGL"];
const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"; // docs /chain/protocol-contracts
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // docs /chain/contracts

function slotToAddress(slot: Hex | undefined): Address | null {
  if (!slot || /^0x0*$/.test(slot)) return null;
  return getAddress(`0x${slot.slice(-40)}`);
}

export async function validateAssets(report = new Report("assets")) {
  const client = makeClient();
  const block = await client.getBlockNumber();
  report.info("pinned block", block.toString());

  // ---- 1. official list ----
  const res = await getJson(`${RHJ_BASE_URL}/assets`);
  if (res.status !== 200) {
    report.fail("GET /rhj/assets", `HTTP ${res.status}`);
    return report;
  }
  const parsed = rhjAssetsResponseSchema.safeParse(res.body);
  if (!parsed.success) {
    report.fail("GET /rhj/assets schema", parsed.error.message.slice(0, 300));
    return report;
  }
  const assets = parsed.data.assets;
  const canonical = canonicalStockTokens(assets, ROBINHOOD_CHAIN_ID);
  const statuses = assets.reduce<Record<string, number>>((m, a) => ((m[a.status] = (m[a.status] ?? 0) + 1), m), {});
  report.pass("GET /rhj/assets", `${assets.length} assets, ${canonical.size} active on 4663`, { statuses, fetchedAt: res.fetchedAt });

  // Bulk cross-check through Multicall3: 5 reads per token.
  const entries = [...canonical.entries()];
  const calls = entries.flatMap(([address]) => [
    { address, abi: stockTokenAbi, functionName: "uid" } as const,
    { address, abi: erc20Abi, functionName: "symbol" } as const,
    { address, abi: erc20Abi, functionName: "decimals" } as const,
    { address, abi: stockTokenAbi, functionName: "uiMultiplier" } as const,
    { address, abi: stockTokenAbi, functionName: "ACCESS_CONTROLLED_REGISTRY" } as const,
  ]);
  const t0 = Date.now();
  const results = await client.multicall({ contracts: calls, blockNumber: block, allowFailure: true });
  const ms = Date.now() - t0;
  const mismatches: string[] = [];
  let multiplierNot1 = 0;
  entries.forEach(([address, a], i) => {
    const [uid, sym, dec, mult, reg] = results.slice(i * 5, i * 5 + 5);
    const problems: string[] = [];
    if (uid?.status !== "success" || String(uid.result).toLowerCase() !== a.id.toLowerCase()) problems.push("uid");
    if (sym?.status !== "success" || sym.result !== a.tokenSymbol) problems.push(`symbol(${String(sym?.result)})`);
    if (dec?.status !== "success" || dec.result !== (a.tokenDecimals ?? 18)) problems.push(`decimals(${String(dec?.result)})`);
    if (mult?.status !== "success" || mult.result !== parseMultiplier(a.currentMultiplier)) {
      problems.push(`multiplier(chain ${String(mult?.result)} vs api ${a.currentMultiplier})`);
    }
    if (reg?.status !== "success" || !sameAddress(String(reg.result), STOCK_REGISTRY)) problems.push("registry");
    if (mult?.status === "success" && mult.result !== 10n ** 18n) multiplierNot1++;
    if (problems.length) mismatches.push(`${a.tokenSymbol} ${address}: ${problems.join(", ")}`);
  });
  const detail = `${entries.length} tokens × 5 reads in ${ms} ms at block ${block}; ${mismatches.length} mismatches; ${multiplierNot1} with uiMultiplier ≠ 1`;
  // A multiplier mismatch can legitimately happen for a few minutes around a scheduled change,
  // so only identity mismatches are hard failures.
  const identityProblems = mismatches.filter((m) => !/^\S+ \S+: multiplier/.test(m));
  if (identityProblems.length) report.fail("onchain vs /rhj/assets", detail, { mismatches });
  else if (mismatches.length) report.warn("onchain vs /rhj/assets", detail, { mismatches });
  else report.pass("onchain vs /rhj/assets", detail);

  // ---- 2. sample tokens ----
  for (const symbol of SAMPLE_SYMBOLS) {
    const hits = [...canonical.entries()].filter(([, a]) => a.tokenSymbol === symbol);
    if (hits.length !== 1) {
      report.fail(`sample ${symbol}`, `${hits.length} canonical entries (expected exactly 1)`);
      continue;
    }
    const [address, a] = hits[0]!;
    const base = { address, abi: stockTokenAbi } as const;
    const [name, totalSupply, totalSupplyUI, mult, next, effAt, paused, oraclePaused] = await client.multicall({
      contracts: [
        { address, abi: erc20Abi, functionName: "name" },
        { address, abi: erc20Abi, functionName: "totalSupply" },
        { ...base, functionName: "totalSupplyUI" },
        { ...base, functionName: "uiMultiplier" },
        { ...base, functionName: "newUIMultiplier" },
        { ...base, functionName: "effectiveAt" },
        { ...base, functionName: "paused" },
        { ...base, functionName: "oraclePaused" },
      ],
      blockNumber: block,
    });
    const code = await client.getCode({ address, blockNumber: block });
    report.pass(`sample ${symbol}`, `${address} "${name.result}"`, {
      address,
      uid: a.id,
      codeBytes: code ? (code.length - 2) / 2 : 0,
      totalSupply: totalSupply.result,
      totalSupplyUI: totalSupplyUI.result,
      uiMultiplier: mult.result,
      newUIMultiplier: next.result,
      effectiveAt: effAt.result,
      pendingChange: next.result !== mult.result,
      paused: paused.result,
      oraclePaused: oraclePaused.result,
      apiCurrentMultiplier: a.currentMultiplier,
      apiPendingMultiplier: a.pendingMultiplier ?? "",
    });
  }

  // ---- 3. WETH & USDG ----
  for (const [label, address, expected] of [
    ["WETH", WETH, { symbol: "WETH", decimals: 18 }],
    ["USDG", USDG, { symbol: "USDG", decimals: 6 }],
  ] as const) {
    const [name, symbol, decimals, supply] = await client.multicall({
      contracts: [
        { address, abi: erc20Abi, functionName: "name" },
        { address, abi: erc20Abi, functionName: "symbol" },
        { address, abi: erc20Abi, functionName: "decimals" },
        { address, abi: erc20Abi, functionName: "totalSupply" },
      ],
      blockNumber: block,
    });
    const impl = slotToAddress(await client.getStorageAt({ address, slot: EIP1967_SLOTS.implementation, blockNumber: block }));
    const admin = slotToAddress(await client.getStorageAt({ address, slot: EIP1967_SLOTS.admin, blockNumber: block }));
    const ok = symbol.result === expected.symbol && decimals.result === expected.decimals;
    report.add(ok ? "PASS" : "FAIL", label, `${address} "${name.result}" ${symbol.result} dec ${decimals.result}`, {
      totalSupply: supply.result,
      eip1967Implementation: impl,
      eip1967Admin: admin,
    });
  }
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const r = await validateAssets();
  process.exitCode = r.finish();
}
