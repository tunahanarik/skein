/**
 * Balance reader: raw balances (and Stock Token multipliers) for a wallet at ONE block.
 * Returns every requested asset, zero balances included — filtering is the engine's job.
 * A failing token never fails the batch; its result is marked FAILED with the reason.
 */
import type { Address } from "viem";
import { erc20Abi, stockTokenAbi } from "../config/abis.js";
import type { CallResult, ChainReader, ContractCall } from "../chain/reader.js";
import type { DataSource } from "../model/provenance.js";
import type { Asset } from "../registry/asset.js";

export type BalanceStatus = "OK" | "FAILED";

export interface BalanceReading {
  assetKey: string;
  status: BalanceStatus;
  raw: bigint | null;
  error: string | null;
  source: DataSource;
  /** Stock Tokens only: uiMultiplier() at the same block, or the read error. */
  multiplier?: { status: "OK" | "FAILED"; valueE18: bigint | null; error: string | null };
}

export interface BalanceBatch {
  blockNumber: bigint;
  readings: Map<string, BalanceReading>;
  calls: number;
}

function describe(r: CallResult | undefined): string {
  if (!r) return "missing result";
  return r.status === "failure" ? `${r.kind}: ${r.error}` : "unexpected result type";
}

export async function readBalances(
  reader: ChainReader,
  wallet: Address,
  assets: readonly Asset[],
  blockNumber: bigint,
  observedAt: string = new Date().toISOString(),
): Promise<BalanceBatch> {
  const src = (contract: Address | undefined, method: string): DataSource => ({
    type: "ONCHAIN",
    provider: "robinhood-chain-rpc",
    chainId: reader.chainId,
    ...(contract ? { contract } : {}),
    method,
    blockNumber,
    observedAt,
  });
  const readings = new Map<string, BalanceReading>();

  // Native coin: one eth_getBalance. It is NOT part of the ERC-20 multicall.
  const native = assets.find((a) => a.type === "NATIVE");
  let calls = 0;
  if (native) {
    calls++;
    try {
      const raw = await reader.getNativeBalance(wallet, blockNumber);
      readings.set(native.key, { assetKey: native.key, status: "OK", raw, error: null, source: src(undefined, "eth_getBalance") });
    } catch (e) {
      readings.set(native.key, { assetKey: native.key, status: "FAILED", raw: null, error: (e as Error).message, source: src(undefined, "eth_getBalance") });
    }
  }

  // ERC-20s: balanceOf for all, plus uiMultiplier for Stock Tokens, in one ordered multicall.
  const erc20 = assets.filter((a) => a.address !== null);
  const plan: { asset: Asset; balanceIdx: number; multIdx: number | null }[] = [];
  const contractCalls: ContractCall[] = [];
  for (const a of erc20) {
    const balanceIdx = contractCalls.push({ address: a.address!, abi: erc20Abi, functionName: "balanceOf", args: [wallet] }) - 1;
    let multIdx: number | null = null;
    if (a.type === "STOCK_TOKEN") multIdx = contractCalls.push({ address: a.address!, abi: stockTokenAbi, functionName: "uiMultiplier" }) - 1;
    plan.push({ asset: a, balanceIdx, multIdx });
  }
  calls += contractCalls.length;
  const res = contractCalls.length ? await reader.multicall(contractCalls, { blockNumber }) : [];

  for (const p of plan) {
    const b = res[p.balanceIdx];
    const ok = b?.status === "success" && typeof b.result === "bigint";
    const reading: BalanceReading = {
      assetKey: p.asset.key,
      status: ok ? "OK" : "FAILED",
      raw: ok ? (b.result as bigint) : null,
      error: ok ? null : describe(b),
      source: src(p.asset.address!, "balanceOf(wallet)"),
    };
    if (p.multIdx !== null) {
      const m = res[p.multIdx];
      const mOk = m?.status === "success" && typeof m.result === "bigint" && (m.result as bigint) > 0n;
      reading.multiplier = {
        status: mOk ? "OK" : "FAILED",
        valueE18: mOk ? (m.result as bigint) : null,
        error: mOk ? null : m?.status === "success" ? `invalid multiplier ${String(m.result)}` : describe(m),
      };
    }
    readings.set(p.asset.key, reading);
  }
  return { blockNumber, readings, calls };
}
