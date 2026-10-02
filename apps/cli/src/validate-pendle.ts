/**
 * Pendle checks: the official API lists chain 4663; every listed 4663 market agrees with its
 * contract (factory, SY/PT/YT, expiry); Stock Token markets' SY wraps the CANONICAL token.
 * Read-only.
 */
import { getAddress, parseAbi, type Address } from "viem";
import { ROBINHOOD_CHAIN_ID } from "@skein/networks/chains";
import { sameAddress } from "@skein/core/lib/validation";
import { canonicalStockTokens, rhjAssetsResponseSchema, RHJ_BASE_URL } from "@skein/robinhood/sources/robinhood";
import { getJson, makeClient } from "./lib/rpc.js";
import { Report } from "./lib/report.js";

const PENDLE_API = "https://api-v2.pendle.finance/core";
// github.com/pendle-finance/pendle-core-v2-public deployments/4663-core.json (marketFactoryV6)
const MARKET_FACTORY_V6: Address = "0x544BF81c855AE84c1e8b65d5E38770898D01EeE2";

const marketAbi = parseAbi([
  "function readTokens() view returns (address sy, address pt, address yt)",
  "function expiry() view returns (uint256)",
  "function isExpired() view returns (bool)",
  "function factory() view returns (address)",
]);
const syAbi = parseAbi(["function yieldToken() view returns (address)", "function exchangeRate() view returns (uint256)"]);

interface PendleMarket {
  name: string;
  protocol: string;
  address: string;
  expiry: string;
  pt: string;
  yt: string;
  sy: string;
  underlyingAsset: string;
  details: { liquidity: number; totalTvl: number; impliedApy: number; underlyingApy: number; aggregatedApy: number };
}

/** Pendle ids look like "4663-0xabc…"; reject any other chain prefix. */
function pendleId(id: string): Address {
  const [chain, addr] = id.split("-");
  if (chain !== String(ROBINHOOD_CHAIN_ID) || !addr) throw new Error(`unexpected Pendle id ${id}`);
  return getAddress(addr);
}

export async function validatePendle(report = new Report("pendle")) {
  const client = makeClient();
  const chains = await getJson<{ chainIds: number[] }>(`${PENDLE_API}/v1/chains`);
  if (!chains.body?.chainIds?.includes(ROBINHOOD_CHAIN_ID)) {
    report.fail("pendle api chains", `4663 not listed (HTTP ${chains.status})`);
    return report;
  }
  report.pass("pendle api chains", "4663 listed");

  const res = await getJson<{ total: number; results: PendleMarket[] }>(`${PENDLE_API}/v2/markets/all?chainId=${ROBINHOOD_CHAIN_ID}`);
  const markets = res.body?.results ?? [];
  report.pass("pendle api markets", `${markets.length} listed markets on 4663`, { fetchedAt: res.fetchedAt });

  const rhj = rhjAssetsResponseSchema.parse((await getJson(`${RHJ_BASE_URL}/assets`)).body);
  const canonical = canonicalStockTokens(rhj.assets, ROBINHOOD_CHAIN_ID);

  const block = await client.getBlock({ blockTag: "latest" });
  const reads = await client.multicall({
    blockNumber: block.number,
    contracts: markets.flatMap((m) => {
      const address = getAddress(m.address);
      return [
        { address, abi: marketAbi, functionName: "readTokens" } as const,
        { address, abi: marketAbi, functionName: "expiry" } as const,
        { address, abi: marketAbi, functionName: "factory" } as const,
        { address: pendleId(m.sy), abi: syAbi, functionName: "yieldToken" } as const,
      ];
    }),
  });

  markets.forEach((m, i) => {
    const [tokens, expiry, factory, yieldToken] = reads.slice(i * 4, i * 4 + 4);
    const label = `market ${m.name} (${m.protocol}) ${m.address.slice(0, 10)}…`;
    if (tokens?.status !== "success" || expiry?.status !== "success" || factory?.status !== "success") {
      report.fail(label, "onchain read failed");
      return;
    }
    const [sy, pt, yt] = tokens.result as readonly [Address, Address, Address];
    const problems = [
      !sameAddress(sy, pendleId(m.sy)) ? "SY" : "",
      !sameAddress(pt, pendleId(m.pt)) ? "PT" : "",
      !sameAddress(yt, pendleId(m.yt)) ? "YT" : "",
      Number(expiry.result) * 1000 !== Date.parse(m.expiry) ? `expiry ${expiry.result} vs ${m.expiry}` : "",
      !sameAddress(factory.result as Address, MARKET_FACTORY_V6) ? `factory ${factory.result}` : "",
    ].filter(Boolean);
    const underlying = yieldToken?.status === "success" ? getAddress(yieldToken.result as Address) : null;
    const stock = underlying ? canonical.get(underlying) : undefined;
    const expired = Number(expiry.result) <= Number(block.timestamp);
    const detail =
      `expiry ${m.expiry.slice(0, 10)}${expired ? " (EXPIRED)" : ""}, implied ${(m.details.impliedApy * 100).toFixed(2)}%, ` +
      `liquidity $${Math.round(m.details.liquidity).toLocaleString("en-US")}` +
      (stock ? `, SY wraps canonical Stock Token ${stock.tokenSymbol}` : "");
    const evidence = { market: m.address, sy, pt, yt, expiry: expiry.result, underlying, canonicalStockToken: stock?.tokenSymbol ?? null, api: m.details, block: block.number };
    if (problems.length) report.fail(label, `${detail}; mismatch: ${problems.join(", ")}`, evidence);
    else report.pass(label, detail, evidence);
  });
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const r = await validatePendle();
  process.exitCode = r.finish();
}
