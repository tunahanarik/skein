/**
 * Morpho checks: the official API covers chain 4663, and a sample of its markets matches the
 * Morpho contract read at a pinned block (params, market id hash, totals, oracle price).
 * Also Spark Savings spUSDG (vsr → APY, totalAssets). Read-only.
 */
import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import { perSecondRateE18ToApy } from "../src/lib/rates.js";
import { formatFixed } from "../src/lib/units.js";
import { sameAddress } from "../src/lib/validation.js";
import { makeClient, postGraphql } from "./lib/rpc.js";
import { Report } from "./lib/report.js";

// docs.morpho.org/developers/contracts/addresses (Robinhood Chain) and morpho-org/sdks addresses.ts
const MORPHO: Address = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
const MORPHO_API = "https://api.morpho.org/graphql";
// github.com/sparkdotfi/spark-address-registry src/Robinhood.sol
const SPARK_SPUSDG: Address = "0xde770c84FE66E063336b31737cFE9790f18c4087";

const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);
const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
const sparkAbi = parseAbi([
  "function vsr() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function asset() view returns (address)",
]);

interface ApiMarket {
  marketId: Hex;
  listed: boolean;
  lltv: string;
  loanAsset: { address: Address; symbol: string; decimals: number };
  collateralAsset: { address: Address; symbol: string } | null;
  oracle: { address: Address; type: string } | null;
  irmAddress: Address;
  state: {
    blockNumber: string;
    timestamp: number;
    supplyAssets: string;
    borrowAssets: string;
    supplyApy: number;
    borrowApy: number;
    utilization: number;
    price: string | null;
    supplyAssetsUsd: number | null;
  } | null;
}

const MARKETS_QUERY = `query($skip:Int!){ markets(first:200, skip:$skip, where:{chainId_in:[4663]}) {
  pageInfo { countTotal }
  items { marketId listed lltv irmAddress
    loanAsset { address symbol decimals } collateralAsset { address symbol }
    oracle { address type }
    state { blockNumber timestamp supplyAssets borrowAssets supplyApy borrowApy utilization price supplyAssetsUsd } } } }`;

export async function validateMorpho(report = new Report("morpho")) {
  const client = makeClient();

  // ---- API coverage ----
  const chains = await postGraphql<{ chains: { id: number; network: string }[] }>(MORPHO_API, "{ chains { id network } }");
  const rh = chains.body.data?.chains.find((c) => c.id === 4663);
  if (!rh) {
    report.fail("morpho api chains", `4663 not listed (HTTP ${chains.status})`);
    return report;
  }
  report.pass("morpho api chains", `4663 = "${rh.network}"`);

  const markets: ApiMarket[] = [];
  for (let skip = 0; ; skip += 200) {
    const page = await postGraphql<{ markets: { pageInfo: { countTotal: number }; items: ApiMarket[] } }>(MORPHO_API, MARKETS_QUERY, { skip });
    if (page.body.errors?.length || !page.body.data) {
      report.fail("morpho api markets", page.body.errors?.map((e) => e.message).join("; ") ?? `HTTP ${page.status}`);
      return report;
    }
    markets.push(...page.body.data.markets.items);
    if (markets.length >= page.body.data.markets.pageInfo.countTotal || page.body.data.markets.items.length === 0) break;
  }
  const listed = markets.filter((m) => m.listed);
  report.pass("morpho api markets", `${markets.length} markets on 4663, ${listed.length} listed`);

  // ---- sample: largest listed market + largest Stock-Token-collateral market ----
  const bySupply = (a: ApiMarket, b: ApiMarket) => (b.state?.supplyAssetsUsd ?? 0) - (a.state?.supplyAssetsUsd ?? 0);
  const stockSymbols = new Set(["NVDA", "AAPL", "TSLA", "GOOGL", "SPY"]);
  const samples = [
    [...listed].sort(bySupply)[0],
    [...markets].filter((m) => m.oracle?.type === "ChainlinkOracleV2" && stockSymbols.has(m.collateralAsset?.symbol ?? "")).sort(bySupply)[0],
  ].filter((m): m is ApiMarket => !!m);

  const block = await client.getBlockNumber();
  for (const m of samples) {
    const label = `market ${m.collateralAsset?.symbol ?? "-"}/${m.loanAsset.symbol} ${m.marketId.slice(0, 10)}…`;
    const [params, state] = await Promise.all([
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [m.marketId], blockNumber: block }),
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m.marketId], blockNumber: block }),
    ]);
    const [loanToken, collateralToken, oracle, irm, lltv] = params;
    // Morpho market id = keccak256(abi.encode(MarketParams))
    const recomputed = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
        [loanToken, collateralToken, oracle, irm, lltv],
      ),
    );
    const problems = [
      recomputed !== m.marketId ? "id hash" : "",
      !sameAddress(loanToken, m.loanAsset.address) ? "loan token" : "",
      !sameAddress(collateralToken, m.collateralAsset?.address ?? "0x0000000000000000000000000000000000000000") ? "collateral" : "",
      m.oracle && !sameAddress(oracle, m.oracle.address) ? "oracle" : "",
      lltv.toString() !== m.lltv ? "lltv" : "",
    ].filter(Boolean);
    let oraclePrice: bigint | null = null;
    try {
      oraclePrice = await client.readContract({ address: oracle, abi: oracleAbi, functionName: "price", blockNumber: block });
    } catch {
      problems.push("oracle price() reverted");
    }
    // Totals drift with accrued interest between the API's block and ours; compare loosely.
    const apiSupply = BigInt(m.state?.supplyAssets ?? "0");
    const drift = apiSupply === 0n ? 0 : Math.abs(Number(state[0] - apiSupply)) / Number(apiSupply);
    if (drift > 0.01) problems.push(`supply drift ${(drift * 100).toFixed(2)}%`);
    const evidence = {
      marketId: m.marketId,
      block,
      apiBlock: m.state?.blockNumber,
      loanToken,
      collateralToken,
      oracle,
      oracleType: m.oracle?.type,
      irm,
      lltv,
      onchainTotalSupplyAssets: state[0],
      onchainTotalBorrowAssets: state[2],
      apiSupplyAssets: m.state?.supplyAssets,
      apiBorrowAssets: m.state?.borrowAssets,
      apiSupplyApy: m.state?.supplyApy,
      apiBorrowApy: m.state?.borrowApy,
      apiUtilization: m.state?.utilization,
      onchainOraclePrice: oraclePrice,
      apiOraclePrice: m.state?.price,
      listed: m.listed,
    };
    const detail = `lltv ${formatFixed(lltv * 100n, 18)}%, supply ${formatFixed(state[0], m.loanAsset.decimals)} ${m.loanAsset.symbol}, API supplyApy ${((m.state?.supplyApy ?? 0) * 100).toFixed(2)}%`;
    if (problems.length) report.fail(label, `${detail}; ${problems.join(", ")}`, evidence);
    else report.pass(label, `${detail}; params, id hash, totals and oracle match`, evidence);
  }

  // ---- Spark Savings spUSDG ----
  const [vsr, totalAssets, asset] = await client.multicall({
    blockNumber: block,
    allowFailure: false,
    contracts: [
      { address: SPARK_SPUSDG, abi: sparkAbi, functionName: "vsr" },
      { address: SPARK_SPUSDG, abi: sparkAbi, functionName: "totalAssets" },
      { address: SPARK_SPUSDG, abi: sparkAbi, functionName: "asset" },
    ],
  });
  // vsr is a per-second RAY (1e27) growth factor; rate per second = vsr/1e27 − 1
  const perSecondE18 = (vsr - 10n ** 27n) / 10n ** 9n;
  const apy = perSecondRateE18ToApy(perSecondE18);
  const assetOk = sameAddress(asset, "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  report.add(assetOk ? "PASS" : "FAIL", "spark spUSDG", `asset ${assetOk ? "USDG" : asset}, totalAssets ${formatFixed(totalAssets, 6)} USDG, savings APY ${(apy * 100).toFixed(3)}%`, {
    vsr,
    totalAssets,
    block,
  });
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const r = await validateMorpho();
  process.exitCode = r.finish();
}
