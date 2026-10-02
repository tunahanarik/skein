/**
 * Offline Pendle world: factory logs, market/PT/YT/SY/RouterStatic contracts and a fake Pendle
 * API. Numbers are modelled on live 2026-09-24 data (docs/research/pendle.md); no network.
 */
import { getAddress, type Address } from "viem";
import { HttpError } from "@skein/core/lib/http";
import { pendleMarketSchema, type PendleApi, type PendleApiResult } from "@skein/protocols/pendle/api";
import { PENDLE_CONTRACTS } from "@skein/protocols/pendle/constants";
import { NOW, NOW_S, NVDA, NVDA_MULT, ONE, UNKNOWN_FAKE_USDG, USDG, WALLET, type WorldState } from "./world.js";

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const DAY = 86_400;

export interface FixtureMarket {
  name: string;
  market: Address;
  pt: Address;
  yt: Address;
  sy: Address;
  yieldToken: Address;
  tokensIn: Address[];
  tokensOut: Address[];
  assetType: 0 | 1;
  dec: number; // PT/YT/SY decimals
  expiry: bigint;
  lnRate: bigint;
  totalPt: bigint;
  totalSy: bigint;
  lpSupply: bigint;
  syRate: bigint;
  yieldTokenPerSy: bigint;
  ptRate: bigint;
  ytRate: bigint;
  lpRate: bigint;
  paused: boolean;
  ptSymbol: string;
  /** overrides for broken-identity tests */
  ptSyOverride?: Address;
  createdAt: bigint;
  api: Record<string, unknown> | "404" | "fail" | null;
}

/** ln(1.0728876216319512) and ln(1.035), 1e18, floor (Python Decimal). */
export const LN_NVDA = 70_353_725_295_053_354n;
export const LN_USDG = 34_401_426_717_332_396n;
export const IMPLIED_NVDA = 72_887_621_631_951_199n; // expm1(LN_NVDA), floor
export const IMPLIED_USDG = 34_999_999_999_999_999n;

function apiMarket(m: Omit<FixtureMarket, "api">, extra: Record<string, unknown>): Record<string, unknown> {
  const tok = (a: Address, symbol: string, decimals: number) => ({ address: a.toLowerCase(), symbol, decimals, name: symbol });
  return {
    address: m.market.toLowerCase(),
    chainId: 4663,
    expiry: new Date(Number(m.expiry) * 1000).toISOString(),
    pt: tok(m.pt, m.ptSymbol, m.dec),
    yt: tok(m.yt, m.ptSymbol.replace(/^PT/, "YT"), m.dec),
    sy: tok(m.sy, "SY", m.dec),
    accountingAsset: tok(m.yieldToken, "X", m.dec),
    rewardTokens: [tok(PENDLE_CONTRACTS.PENDLE, "PENDLE", 18)],
    inputTokens: m.tokensIn.map((a) => tok(a, "X", m.dec)),
    isWhitelistedPro: true,
    isWhitelistedSimple: false,
    isActive: true,
    liquidity: { usd: 0, acc: 0 },
    dataUpdatedAt: new Date(NOW.getTime() - 300_000).toISOString(),
    underlyingRewardApyBreakdown: [],
    ...extra,
  };
}

export function fixturePendleMarkets(): Record<string, FixtureMarket> {
  const base = (i: number) => ({ market: addr(0xe000 + i), pt: addr(0xe100 + i), yt: addr(0xe200 + i), sy: addr(0xe300 + i), createdAt: 70_000_000n + BigInt(i) });
  const nvdaCore = {
    ...base(1),
    name: "NVDA",
    yieldToken: NVDA,
    tokensIn: [NVDA],
    tokensOut: [NVDA],
    assetType: 1 as const,
    dec: 18,
    expiry: BigInt(NOW_S + 21 * DAY),
    lnRate: LN_NVDA,
    totalPt: 591_670_064_264_712_100_000n,
    totalSy: 96_039_174_292_665_220_000n,
    lpSupply: 219_607_894_982_972_140_000n,
    syRate: NVDA_MULT,
    yieldTokenPerSy: ONE,
    ptRate: 996_025_636_015_812_527n,
    ytRate: 3_974_363_984_187_473n,
    lpRate: 3_121_163_617_832_159_157n,
    paused: false,
    ptSymbol: "PT-NVDA-15OCT2026",
  };
  const usdgCore = {
    ...base(2),
    name: "USDG",
    yieldToken: USDG,
    tokensIn: [USDG],
    tokensOut: [USDG],
    assetType: 0 as const,
    dec: 6,
    expiry: BigInt(NOW_S + 182 * DAY),
    lnRate: LN_USDG,
    totalPt: 14_806_484_765n,
    totalSy: 35_264_479_236n,
    lpSupply: 22_850_435_202n,
    syRate: ONE,
    yieldTokenPerSy: 1_000_000n,
    ptRate: 982_975_000_000_000_000n,
    ytRate: 17_025_000_000_000_000n,
    lpRate: 2_180_139_689_561_208_500n,
    paused: false,
    ptSymbol: "PT-USDG-25MAR2027",
  };
  const expiredCore = { ...usdgCore, ...base(3), name: "USDG-EXPIRED", expiry: BigInt(NOW_S - DAY), ptRate: ONE, ytRate: 0n, totalPt: 1_000_000_000n, totalSy: 3_000_000_000n, ptSymbol: "PT-USDG-TEST-23SEP2026" };
  const lookalikeCore = { ...usdgCore, ...base(4), name: "FAKE-USDG", yieldToken: UNKNOWN_FAKE_USDG, tokensIn: [UNKNOWN_FAKE_USDG], tokensOut: [UNKNOWN_FAKE_USDG], ptSymbol: "PT-USDG-FAKE" };
  const brokenCore = { ...usdgCore, ...base(5), name: "BROKEN", ptSyOverride: addr(0xdead), ptSymbol: "PT-USDG-BROKEN" };
  const dustCore = { ...usdgCore, ...base(6), name: "USDG-DUST", totalPt: 500_000n, totalSy: 495_000n, ptSymbol: "PT-USDG-DUST" };
  return {
    nvda: {
      ...nvdaCore,
      api: apiMarket(nvdaCore, {
        liquidity: { usd: 153_230.89, acc: 685.43 },
        underlyingApy: 0,
        underlyingInterestApy: 0,
        underlyingRewardApy: 0,
        impliedApy: 0.07288762163195117,
        ytFloatingApy: -1,
        ptDiscount: 0.003973441840546155,
        swapFeeApy: 0.0030587952052034684,
        pendleApy: 0.01,
        lpRewardApy: 0,
        aggregatedApy: 0.06572588087892242,
        ytRoi: -1,
        ptRoi: 0.003988721916208027,
        extendedInfo: { pyUnit: "NVDA Shares", ptEqualsPyUnit: false, feeRate: 0.0013 },
      }),
    },
    usdg: {
      ...usdgCore,
      api: apiMarket(usdgCore, {
        isWhitelistedPro: false,
        liquidity: { usd: 49_817.14, acc: 49_819.62 },
        underlyingApy: 0.033,
        underlyingRewardApy: 0.033,
        underlyingRewardApyBreakdown: [{ asset: { address: USDG.toLowerCase(), symbol: "USDG" }, absoluteApy: 0.033, relativeApy: 1, source: "EXTERNAL_REWARD" }],
        impliedApy: 0.03499996108977155,
        ytFloatingApy: -0.1558757717253163,
        swapFeeApy: 0,
        pendleApy: 0,
        lpRewardApy: 0.02335882455267836,
        aggregatedApy: 0.03358430229558497,
        ytRoi: -0.08,
        ptRoi: 0.0172,
        extendedInfo: { pyUnit: "USDG", ptEqualsPyUnit: true, feeRate: 0.0028 },
      }),
    },
    expired: { ...expiredCore, api: null },
    lookalike: { ...lookalikeCore, api: apiMarket(lookalikeCore, { impliedApy: 0.035, liquidity: { usd: 50_000, acc: 50_000 } }) },
    broken: { ...brokenCore, api: apiMarket(brokenCore, { impliedApy: 0.035, liquidity: { usd: 50_000, acc: 50_000 } }) },
    dust: { ...dustCore, api: "404" },
  };
}

export class FakePendleApi implements PendleApi {
  calls: string[] = [];
  down = false;
  constructor(public markets: Record<string, FixtureMarket>) {}
  async market(chainId: number, market: Address): Promise<PendleApiResult> {
    this.calls.push(market.toLowerCase());
    const url = `https://api-v2.pendle.finance/core/v1/${chainId}/markets/${market}`;
    if (this.down) throw new HttpError("HTTP 503", url, 503, "HTTP_STATUS");
    const m = Object.values(this.markets).find((x) => x.market.toLowerCase() === market.toLowerCase());
    if (!m || m.api === "404" || m.api === null) throw new HttpError("HTTP 404", url, 404, "HTTP_STATUS");
    if (m.api === "fail") throw new HttpError("HTTP 500", url, 500, "HTTP_STATUS");
    return { market: pendleMarketSchema.parse(m.api), fetchedAt: NOW.toISOString(), url };
  }
}

/** Install Pendle contracts + factory logs into a world. */
export function installPendle(world: WorldState, markets: Record<string, FixtureMarket>, balances: Record<string, { pt?: bigint; yt?: bigint; lp?: bigint }> = {}): void {
  const contracts = (world.contracts ??= new Map());
  const logs = (world.logs ??= []);
  const set = (a: Address, h: Record<string, unknown>) => contracts.set(a.toLowerCase(), { ...(contracts.get(a.toLowerCase()) ?? {}), ...h });
  const byMarket = new Map(Object.values(markets).map((m) => [m.market.toLowerCase(), m]));
  const of = (args: readonly unknown[]) => {
    const m = byMarket.get(String(args[0]).toLowerCase());
    if (!m) throw new Error("unknown market");
    return m;
  };
  set(PENDLE_CONTRACTS.marketFactoryV6, { isValidMarket: (a: readonly unknown[]) => byMarket.has(String(a[0]).toLowerCase()) });
  set(PENDLE_CONTRACTS.yieldContractFactoryV6, {
    isPT: (a: readonly unknown[]) => Object.values(markets).some((m) => m.pt.toLowerCase() === String(a[0]).toLowerCase()),
    isYT: (a: readonly unknown[]) => Object.values(markets).some((m) => m.yt.toLowerCase() === String(a[0]).toLowerCase()),
  });
  set(PENDLE_CONTRACTS.routerStatic, {
    getPtToAssetRate: (a: readonly unknown[]) => of(a).ptRate,
    getYtToAssetRate: (a: readonly unknown[]) => of(a).ytRate,
    getLpToAssetRate: (a: readonly unknown[]) => of(a).lpRate,
  });
  world.meta.set(USDG.toLowerCase(), { symbol: "USDG", name: "Global Dollar", decimals: 6 });
  let logIndex = 0;
  for (const [key, m] of Object.entries(markets)) {
    const bal = balances[key] ?? {};
    const balOf = (v: bigint | undefined) => (a: readonly unknown[]) => (String(a[0]).toLowerCase() === WALLET.toLowerCase() ? (v ?? 0n) : 0n);
    set(m.market, {
      readTokens: [m.sy, m.pt, m.yt],
      expiry: m.expiry,
      isExpired: m.expiry <= BigInt(NOW_S),
      decimals: 18,
      totalSupply: m.lpSupply,
      getRewardTokens: [PENDLE_CONTRACTS.PENDLE],
      _storage: [m.totalPt, m.totalSy, m.lnRate, 0, 1, 1],
      balanceOf: balOf(bal.lp),
    });
    set(m.pt, { SY: m.ptSyOverride ?? m.sy, YT: m.yt, expiry: m.expiry, decimals: m.dec, symbol: m.ptSymbol, balanceOf: balOf(bal.pt) });
    set(m.yt, { PT: m.pt, SY: m.sy, decimals: m.dec, symbol: m.ptSymbol.replace(/^PT/, "YT"), balanceOf: balOf(bal.yt) });
    set(m.sy, {
      yieldToken: m.yieldToken,
      getTokensIn: m.tokensIn,
      getTokensOut: m.tokensOut,
      assetInfo: [m.assetType, m.yieldToken, m.dec],
      exchangeRate: m.syRate,
      decimals: m.dec,
      symbol: `SY-${m.name}`,
      paused: m.paused,
      previewRedeem: m.yieldTokenPerSy,
    });
    logs.push({ address: PENDLE_CONTRACTS.marketFactoryV6, eventName: "CreateNewMarket", blockNumber: m.createdAt, logIndex: logIndex++, args: { market: m.market, PT: m.pt, scalarRoot: 10n ** 19n, initialAnchor: ONE, lnFeeRateRoot: 10n ** 15n } });
  }
}
