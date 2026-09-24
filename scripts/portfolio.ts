/**
 * Read-only portfolio probe: which canonical assets does a wallet hold, what is the correct
 * display balance, and what is it worth — with every number's source printed.
 *
 *   pnpm portfolio 0xWallet
 *
 * Balances: one Multicall3 aggregate3 over the registry (195 Stock Tokens + WETH + USDG + ETH).
 * Prices: Chainlink token feed when one exists and is within its heartbeat; otherwise the
 * Robinhood quote mid × uiMultiplier; otherwise "unpriced" (never a guess).
 */
import { formatUnits, type Address } from "viem";
import { chainlinkAggregatorAbi, erc20Abi, stockTokenAbi } from "../src/config/abis.js";
import { ROBINHOOD_CHAIN_ID } from "../src/config/chains.js";
import {
  shareEquivalentRaw,
  stockTokenUsdE18,
  underlyingMidFromQuote,
  type StockPrice,
} from "../src/lib/stockToken.js";
import { formatFixed, usdValueE18 } from "../src/lib/units.js";
import { parseWalletAddress } from "../src/lib/validation.js";
import { CHAINLINK_DIRECTORY_URL, chainlinkDirectorySchema, findFeedByName, stockFeedTicker } from "../src/sources/chainlink.js";
import { canonicalStockTokens, rhjAssetsResponseSchema, rhjPricesResponseSchema, RHJ_BASE_URL } from "../src/sources/robinhood.js";
import { getJson, makeClient } from "./lib/rpc.js";
import { Report } from "./lib/report.js";

const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";

const usd = (e18: bigint) => `$${Number(formatFixed(e18, 18)).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export async function portfolio(wallet: Address, report = new Report("portfolio")) {
  const client = makeClient();
  const block = await client.getBlock({ blockTag: "latest" });
  const now = Number(block.timestamp);

  const [assetsRes, pricesRes, dirRes] = await Promise.all([
    getJson(`${RHJ_BASE_URL}/assets`),
    getJson(`${RHJ_BASE_URL}/prices`),
    getJson(CHAINLINK_DIRECTORY_URL),
  ]);
  const canonical = canonicalStockTokens(rhjAssetsResponseSchema.parse(assetsRes.body).assets, ROBINHOOD_CHAIN_ID);
  const quotes = new Map(rhjPricesResponseSchema.parse(pricesRes.body).quotes.map((q) => [q.tokenSymbol, q] as const));
  const feeds = chainlinkDirectorySchema.parse(dirRes.body);
  const feedByTicker = new Map(feeds.map((f) => [stockFeedTicker(f), f] as const).filter((e): e is [string, (typeof feeds)[number]] => e[0] !== null));
  const ethFeed = findFeedByName(feeds, "ETH / USD")!;
  const usdgFeed = findFeedByName(feeds, "USDG / USD")!;

  // ---- balances + multipliers in one multicall, pinned to one block ----
  const stocks = [...canonical.entries()];
  const t0 = Date.now();
  // Balances and multipliers are all uint256: one multicall. Feeds use a different ABI: a second one.
  const res = await client.multicall({
    blockNumber: block.number,
    contracts: [
      { address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [wallet] },
      { address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [wallet] },
      ...stocks.flatMap(([address]) => [
        { address, abi: erc20Abi, functionName: "balanceOf", args: [wallet] } as const,
        { address, abi: stockTokenAbi, functionName: "uiMultiplier" } as const,
      ]),
    ],
  });
  const [ethRoundRes, usdgRoundRes] = await client.multicall({
    blockNumber: block.number,
    contracts: [
      { address: ethFeed.proxyAddress, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" },
      { address: usdgFeed.proxyAddress, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" },
    ],
  });
  const ethBalance = await client.getBalance({ address: wallet, blockNumber: block.number });
  report.info("scan", `${wallet} at block ${block.number}: ${res.length + 2} reads in ${Date.now() - t0} ms`);

  let totalE18 = 0n;
  const unpriced: string[] = [];
  const ethRound = ethRoundRes?.status === "success" ? ethRoundRes.result : null;
  const usdgRound = usdgRoundRes?.status === "success" ? usdgRoundRes.result : null;

  // ETH + WETH at Chainlink ETH/USD (8 decimals)
  const wethBal = res[0]?.status === "success" ? (res[0].result as bigint) : 0n;
  if (ethRound) {
    for (const [label, bal] of [["ETH", ethBalance], ["WETH", wethBal]] as const) {
      if (bal === 0n) continue;
      const v = usdValueE18(bal, 18, ethRound[1], 8);
      totalE18 += v;
      report.info(label, `${formatUnits(bal, 18)} × ETH/USD ${formatFixed(ethRound[1], 8)} (Chainlink, age ${now - Number(ethRound[3])}s) = ${usd(v)}`);
    }
  }
  const usdgBal = res[1]?.status === "success" ? (res[1].result as bigint) : 0n;
  if (usdgBal > 0n && usdgRound) {
    const v = usdValueE18(usdgBal, 6, usdgRound[1], 8);
    totalE18 += v;
    report.info("USDG", `${formatUnits(usdgBal, 6)} × USDG/USD ${formatFixed(usdgRound[1], 8)} (Chainlink, age ${now - Number(usdgRound[3])}s) = ${usd(v)}`);
  }

  // Stock feeds are read lazily only for tokens the wallet holds.
  const held = stocks
    .map(([address, a], i) => ({ address, a, bal: res[2 + i * 2], mult: res[3 + i * 2] }))
    .filter((h) => h.bal?.status === "success" && (h.bal.result as bigint) > 0n);
  const feedReads = await client.multicall({
    blockNumber: block.number,
    contracts: held.map((h) => {
      const f = feedByTicker.get(h.a.tokenSymbol);
      return { address: f?.proxyAddress ?? WETH, abi: chainlinkAggregatorAbi, functionName: "latestRoundData" } as const;
    }),
  });

  const rows: Record<string, unknown>[] = [];
  held.forEach((h, i) => {
    const raw = h.bal!.result as bigint;
    const mult = h.mult?.status === "success" ? (h.mult.result as bigint) : null;
    if (!mult) {
      unpriced.push(`${h.a.tokenSymbol} (uiMultiplier read failed)`);
      return;
    }
    const feed = feedByTicker.get(h.a.tokenSymbol);
    const fr = feed && feedReads[i]?.status === "success" ? (feedReads[i].result as readonly [bigint, bigint, bigint, bigint, bigint]) : null;
    const feedAge = fr ? now - Number(fr[3]) : null;
    let price: StockPrice | null = null;
    let priceSource = "";
    if (fr && feed && fr[1] > 0n && feedAge !== null && feedAge <= feed.heartbeat) {
      price = { kind: "TOKEN_PRICE", raw: fr[1], decimals: 8 };
      priceSource = `Chainlink token feed ${feed.proxyAddress} (multiplier included), age ${feedAge}s`;
    } else {
      const q = quotes.get(h.a.tokenSymbol);
      const mid = q && !q.isTradingHalt ? underlyingMidFromQuote(q.bid, q.ask) : null;
      if (mid) {
        price = mid;
        priceSource = `Robinhood /rhj/prices mid (underlying) × uiMultiplier, quote ${q!.generatedAt}`;
      }
    }
    const shares = shareEquivalentRaw(raw, mult);
    if (!price) {
      unpriced.push(h.a.tokenSymbol);
      rows.push({ symbol: h.a.tokenSymbol, raw, tokens: formatFixed(raw, 18), shareEquivalent: formatFixed(shares, 18), usd: null });
      return;
    }
    const v = stockTokenUsdE18(raw, 18, price, mult);
    totalE18 += v;
    rows.push({
      symbol: h.a.tokenSymbol,
      address: h.address,
      raw,
      tokens: formatFixed(raw, 18),
      uiMultiplier: formatFixed(mult, 18),
      shareEquivalent: formatFixed(shares, 18),
      priceKind: price.kind,
      price: formatFixed(price.raw, price.decimals),
      priceSource,
      usdE18: v,
    });
  });
  rows.sort((x, y) => Number(((y.usdE18 as bigint) ?? 0n) - ((x.usdE18 as bigint) ?? 0n)));
  for (const r of rows.slice(0, 10)) {
    report.info(
      r.symbol as string,
      r.usdE18 === undefined
        ? `${r.tokens} tokens (≈ ${r.shareEquivalent} shares) — UNPRICED`
        : `${r.tokens} tokens × mult ${r.uiMultiplier} = ${r.shareEquivalent} share-equiv; ${r.priceKind} ${r.price} → ${usd(r.usdE18 as bigint)} [${r.priceSource}]`,
    );
  }
  if (rows.length > 10) report.info("…", `${rows.length - 10} more Stock Token holdings in the snapshot`);
  report.pass("portfolio", `${held.length} Stock Tokens held; total priced value ${usd(totalE18)}; unpriced: ${unpriced.length ? unpriced.join(", ") : "none"}`, {
    wallet,
    block: block.number,
    rows,
  });
  return report;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}`) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: pnpm portfolio <wallet address>");
    process.exit(2);
  }
  const r = await portfolio(parseWalletAddress(arg));
  process.exitCode = r.finish();
}
