/**
 * Network-level checks: chain id, head freshness, block cadence, Multicall contracts, and
 * the Arbitrum precompile. Read-only.
 */
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { parseChainId } from "@skein/core/lib/validation";
import { ROBINHOOD_CHAIN_ID, SUPPORTED_CHAIN_IDS } from "@skein/networks/chains";
import { makeClient, rpcUrl } from "./lib/rpc.js";
import { Report } from "./lib/report.js";

const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";
const RH_L2_MULTICALL: Address = "0x2cAC2D899eCC914d704FeaAE33ac1bF36277DaD1"; // docs /chain/protocol-contracts
const MULTICALL_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[])",
  "function getBlockNumber() view returns (uint256)",
]);
const ARBSYS: Address = "0x0000000000000000000000000000000000000064";

export async function validateNetwork(report = new Report("network")): Promise<Report> {
  const client = makeClient();
  report.info("rpc", rpcUrl());

  const rawId = await client.request({ method: "eth_chainId" });
  try {
    const id = parseChainId(rawId, SUPPORTED_CHAIN_IDS);
    report.pass("eth_chainId", `${rawId} = ${id}`, { rawId });
  } catch (e) {
    report.fail("eth_chainId", `${rawId}: ${(e as Error).message}`);
    return report; // nothing else is meaningful on the wrong chain
  }

  const arbChainId = await client.readContract({
    address: ARBSYS,
    abi: parseAbi(["function arbChainID() view returns (uint256)"]),
    functionName: "arbChainID",
  });
  if (arbChainId === BigInt(ROBINHOOD_CHAIN_ID)) report.pass("ArbSys.arbChainID", arbChainId.toString());
  else report.fail("ArbSys.arbChainID", `expected ${ROBINHOOD_CHAIN_ID}, got ${arbChainId}`);

  const head = await client.getBlock({ blockTag: "latest" });
  const ageS = Math.floor(Date.now() / 1000) - Number(head.timestamp);
  const headEvidence = { number: head.number, hash: head.hash, timestamp: head.timestamp };
  if (ageS <= 60) report.pass("latest block", `#${head.number} age ${ageS}s`, headEvidence);
  else report.warn("latest block", `#${head.number} is ${ageS}s old (RPC lagging?)`, headEvidence);

  // Block cadence over the last 1000 blocks (timestamps have 1 s resolution, so use a wide span).
  const past = await client.getBlock({ blockNumber: head.number - 1000n });
  const perBlock = Number(head.timestamp - past.timestamp) / 1000;
  report.info("block time", `${perBlock.toFixed(3)} s/block over 1000 blocks`, { from: past.number, to: head.number });

  // Multicall contracts: which ones exist and which support aggregate3 (what viem uses).
  for (const [label, address] of [
    ["Multicall3 (canonical)", MULTICALL3],
    ["Robinhood L2 Multicall (docs)", RH_L2_MULTICALL],
  ] as const) {
    const code = await client.getCode({ address });
    const size = code ? (code.length - 2) / 2 : 0;
    if (size === 0) {
      report.fail(label, `no code at ${address}`);
      continue;
    }
    const data = encodeFunctionData({
      abi: MULTICALL_ABI,
      functionName: "aggregate3",
      args: [[{ target: MULTICALL3, allowFailure: true, callData: encodeFunctionData({ abi: MULTICALL_ABI, functionName: "getBlockNumber" }) }]],
    });
    let aggregate3 = false;
    try {
      await client.call({ to: address, data });
      aggregate3 = true;
    } catch {
      aggregate3 = false;
    }
    report.add(
      label.startsWith("Multicall3") && !aggregate3 ? "FAIL" : "PASS",
      label,
      `${address} code ${size} bytes; aggregate3 ${aggregate3 ? "supported" : "NOT supported"}`,
      { address, codeBytes: size, aggregate3 },
    );
  }

  // Head tags used for finality: the chain's own tags, never an invented depth.
  for (const tag of ["safe", "finalized"] as const) {
    try {
      const b = await client.getBlock({ blockTag: tag });
      report.info(`${tag} tag`, `#${b.number}, ${head.number - b.number} blocks / ${Number(head.timestamp - b.timestamp)} s behind latest`);
    } catch (e) {
      report.warn(`${tag} tag`, (e as Error).message.split("\n")[0] ?? "error");
    }
  }
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const r = await validateNetwork();
  process.exitCode = r.finish();
}
