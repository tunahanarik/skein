/**
 * Onchain reads for Pendle, all through the ChainReader (multicall, pinned block).
 *
 *   discovery  CreateNewMarket logs of marketFactoryV6, each confirmed by isValidMarket()
 *   identity   market.readTokens / expiry, PT.SY/YT/expiry, YT.PT/SY, SY.yieldToken/tokensIn/
 *              tokensOut/assetInfo, yieldContractFactory.isPT/isYT, token metadata
 *              — slow-changing configuration, cached by the adapter
 *   state      market._storage (pool PT/SY, lastLnImpliedRate), LP totalSupply, SY.exchangeRate,
 *              SY.paused, SY.previewRedeem, RouterStatic PT/YT/LP→asset rates — every run
 */
import type { Address } from "viem";
import type { CallResult, ChainReader, ContractCall } from "@skein/chain/reader";
import { sameAddress } from "@skein/core/lib/validation";
import {
  createNewMarketEvent,
  erc20MetaAbi,
  marketAbi,
  marketFactoryAbi,
  PENDLE_CONTRACTS,
  ptAbi,
  routerStaticAbi,
  SY_ASSET_TYPES,
  syAbi,
  yieldFactoryAbi,
  ytAbi,
} from "./constants.js";

export interface DiscoveredMarket {
  market: Address;
  pt: Address;
  createdAtBlock: bigint;
  scalarRoot: bigint;
  initialAnchor: bigint;
  lnFeeRateRoot: bigint;
}

/** CreateNewMarket logs in [fromBlock, toBlock]. Throws on RPC failure (no partial list). */
export async function discoverMarkets(reader: ChainReader, fromBlock: bigint, toBlock: bigint): Promise<DiscoveredMarket[]> {
  if (toBlock < fromBlock) return [];
  const logs = await reader.getLogs({ address: PENDLE_CONTRACTS.marketFactoryV6, event: createNewMarketEvent, fromBlock, toBlock });
  return logs.map((l) => ({
    market: l.args.market as Address,
    pt: l.args.PT as Address,
    createdAtBlock: l.blockNumber,
    scalarRoot: l.args.scalarRoot as bigint,
    initialAnchor: l.args.initialAnchor as bigint,
    lnFeeRateRoot: l.args.lnFeeRateRoot as bigint,
  }));
}

export interface TokenMeta {
  address: Address;
  decimals: number | null;
  symbol: string | null;
}

export interface IdentityCheck {
  check: string;
  ok: boolean | null;
  detail: string;
}

export interface MarketIdentity {
  market: Address;
  sy: Address;
  pt: Address;
  yt: Address;
  expiry: bigint | null;
  lpDecimals: number | null;
  pt_: TokenMeta;
  yt_: TokenMeta;
  sy_: TokenMeta;
  yieldToken: TokenMeta | null;
  tokensIn: TokenMeta[];
  tokensOut: Address[];
  accounting: { type: (typeof SY_ASSET_TYPES)[number] | "UNKNOWN"; asset: TokenMeta | null; decimals: number | null } | null;
  rewardTokens: Address[];
  /** Every structural check performed; any `false` means the market's identity is not verified. */
  checks: IdentityCheck[];
  readAtBlock: bigint;
}

const val = <T>(r: CallResult | undefined): T | null => (r?.status === "success" ? (r.result as T) : null);

/**
 * Identity for a set of market addresses (three dependent multicall rounds). A market whose
 * readTokens() fails is returned with `checks` explaining why and zero addresses.
 */
export async function readIdentities(reader: ChainReader, markets: readonly Address[], blockNumber: bigint): Promise<Map<string, MarketIdentity | { error: string }>> {
  const out = new Map<string, MarketIdentity | { error: string }>();
  if (!markets.length) return out;
  const opts = { blockNumber };
  // round 1: market-level
  const r1 = await reader.multicall(
    markets.flatMap((m): ContractCall[] => [
      { address: m, abi: marketAbi, functionName: "readTokens" },
      { address: m, abi: marketAbi, functionName: "expiry" },
      { address: m, abi: marketAbi, functionName: "decimals" },
      { address: m, abi: marketAbi, functionName: "getRewardTokens" },
      { address: PENDLE_CONTRACTS.marketFactoryV6, abi: marketFactoryAbi, functionName: "isValidMarket", args: [m] },
    ]),
    opts,
  );
  const base = markets.map((m, i) => {
    const o = i * 5;
    const tokens = val<readonly [Address, Address, Address]>(r1[o]);
    return {
      market: m,
      tokens,
      tokensError: r1[o]?.status === "failure" ? r1[o].error : null,
      expiry: val<bigint>(r1[o + 1]),
      lpDecimals: val<number>(r1[o + 2]),
      rewardTokens: val<readonly Address[]>(r1[o + 3]) ?? [],
      isValid: val<boolean>(r1[o + 4]),
    };
  });
  const ok = base.filter((b) => b.tokens);
  for (const b of base) if (!b.tokens) out.set(b.market.toLowerCase(), { error: `readTokens() failed: ${b.tokensError ?? "unknown"}` });

  // round 2: PT / YT / SY / factory checks
  const PER2 = 17;
  const r2 = await reader.multicall(
    ok.flatMap((b): ContractCall[] => {
      const [sy, pt, yt] = b.tokens!;
      return [
        { address: pt, abi: ptAbi, functionName: "SY" },
        { address: pt, abi: ptAbi, functionName: "YT" },
        { address: pt, abi: ptAbi, functionName: "expiry" },
        { address: pt, abi: ptAbi, functionName: "decimals" },
        { address: pt, abi: ptAbi, functionName: "symbol" },
        { address: yt, abi: ytAbi, functionName: "PT" },
        { address: yt, abi: ytAbi, functionName: "SY" },
        { address: yt, abi: ytAbi, functionName: "decimals" },
        { address: yt, abi: ytAbi, functionName: "symbol" },
        { address: sy, abi: syAbi, functionName: "yieldToken" },
        { address: sy, abi: syAbi, functionName: "getTokensIn" },
        { address: sy, abi: syAbi, functionName: "getTokensOut" },
        { address: sy, abi: syAbi, functionName: "assetInfo" },
        { address: sy, abi: syAbi, functionName: "decimals" },
        { address: sy, abi: syAbi, functionName: "symbol" },
        { address: PENDLE_CONTRACTS.yieldContractFactoryV6, abi: yieldFactoryAbi, functionName: "isPT", args: [pt] },
        { address: PENDLE_CONTRACTS.yieldContractFactoryV6, abi: yieldFactoryAbi, functionName: "isYT", args: [yt] },
      ];
    }),
    opts,
  );
  const partial = ok.map((b, i) => {
    const o = i * PER2;
    const g = <T>(k: number) => val<T>(r2[o + k]);
    const info = g<readonly [number, Address, number]>(12);
    return { b, ptSY: g<Address>(0), ptYT: g<Address>(1), ptExpiry: g<bigint>(2), ptDec: g<number>(3), ptSym: g<string>(4), ytPT: g<Address>(5), ytSY: g<Address>(6), ytDec: g<number>(7), ytSym: g<string>(8), yieldToken: g<Address>(9), tokensIn: g<readonly Address[]>(10) ?? null, tokensOut: g<readonly Address[]>(11) ?? null, info, syDec: g<number>(13), sySym: g<string>(14), isPT: g<boolean>(15), isYT: g<boolean>(16) };
  });

  // round 3: metadata of the external tokens (yield token, tokens in, accounting asset), de-duplicated
  const need = new Map<string, Address>();
  for (const p of partial) for (const a of [p.yieldToken, ...(p.tokensIn ?? []), p.info?.[1] ?? null]) if (a) need.set(a.toLowerCase(), a);
  const list = [...need.values()];
  const r3 = await reader.multicall(list.flatMap((a): ContractCall[] => [{ address: a, abi: erc20MetaAbi, functionName: "decimals" }, { address: a, abi: erc20MetaAbi, functionName: "symbol" }]), opts);
  const meta = new Map<string, TokenMeta>(list.map((a, i) => [a.toLowerCase(), { address: a, decimals: val<number>(r3[i * 2]), symbol: val<string>(r3[i * 2 + 1]) }]));
  const metaOf = (a: Address): TokenMeta => meta.get(a.toLowerCase()) ?? { address: a, decimals: null, symbol: null };

  for (const p of partial) {
    const [sy, pt, yt] = p.b.tokens!;
    const checks: IdentityCheck[] = [];
    const chk = (check: string, okv: boolean | null, detail: string) => checks.push({ check, ok: okv, detail });
    const eq = (a: Address | null, b: Address) => (a === null ? null : sameAddress(a, b));
    chk("factory.isValidMarket(market)", p.b.isValid, "marketFactoryV6 recognises the market");
    chk("yieldContractFactory.isPT(PT)", p.isPT, "PT issued by the official yield contract factory");
    chk("yieldContractFactory.isYT(YT)", p.isYT, "YT issued by the official yield contract factory");
    chk("PT.SY() == market SY", eq(p.ptSY, sy), `PT.SY=${p.ptSY ?? "unreadable"}`);
    chk("PT.YT() == market YT", eq(p.ptYT, yt), `PT.YT=${p.ptYT ?? "unreadable"}`);
    chk("YT.PT() == market PT", eq(p.ytPT, pt), `YT.PT=${p.ytPT ?? "unreadable"}`);
    chk("YT.SY() == market SY", eq(p.ytSY, sy), `YT.SY=${p.ytSY ?? "unreadable"}`);
    chk("PT.expiry() == market.expiry()", p.ptExpiry === null || p.b.expiry === null ? null : p.ptExpiry === p.b.expiry, `PT=${p.ptExpiry ?? "?"} market=${p.b.expiry ?? "?"}`);
    chk("PT/SY decimals equal", p.ptDec === null || p.syDec === null ? null : p.ptDec === p.syDec, `PT=${p.ptDec ?? "?"} SY=${p.syDec ?? "?"}`);
    const assetType = p.info ? (SY_ASSET_TYPES[p.info[0]] ?? "UNKNOWN") : "UNKNOWN";
    out.set(p.b.market.toLowerCase(), {
      market: p.b.market,
      sy,
      pt,
      yt,
      expiry: p.b.expiry,
      lpDecimals: p.b.lpDecimals,
      pt_: { address: pt, decimals: p.ptDec, symbol: p.ptSym },
      yt_: { address: yt, decimals: p.ytDec, symbol: p.ytSym },
      sy_: { address: sy, decimals: p.syDec, symbol: p.sySym },
      yieldToken: p.yieldToken ? metaOf(p.yieldToken) : null,
      tokensIn: (p.tokensIn ?? []).map(metaOf),
      tokensOut: [...(p.tokensOut ?? [])],
      accounting: p.info ? { type: assetType, asset: metaOf(p.info[1]), decimals: p.info[2] } : null,
      rewardTokens: [...p.b.rewardTokens],
      checks,
      readAtBlock: blockNumber,
    });
  }
  return out;
}

export interface MarketState {
  totalPt: bigint | null;
  totalSy: bigint | null;
  lastLnImpliedRate: bigint | null;
  lpTotalSupply: bigint | null;
  isExpired: boolean | null;
  syExchangeRate: bigint | null;
  syPaused: boolean | null;
  /** yieldToken units returned for exactly 1 SY (10^syDecimals), via SY.previewRedeem. */
  yieldTokenPerSy: bigint | null;
  ptToAssetRate: bigint | null;
  ytToAssetRate: bigint | null;
  lpToAssetRate: bigint | null;
  errors: string[];
}

/** previewRedeem(yieldToken) is only meaningful when the SY lists the yield token as an output. */
export function canPreviewRedeem(i: MarketIdentity): boolean {
  return !!i.yieldToken && i.sy_.decimals !== null && i.tokensOut.some((t) => sameAddress(t, i.yieldToken!.address));
}

export async function readStates(reader: ChainReader, ids: readonly MarketIdentity[], blockNumber: bigint): Promise<Map<string, MarketState>> {
  const PER = 9;
  const r = await reader.multicall(
    ids.flatMap((i): ContractCall[] => [
      { address: i.market, abi: marketAbi, functionName: "_storage" },
      { address: i.market, abi: marketAbi, functionName: "totalSupply" },
      { address: i.market, abi: marketAbi, functionName: "isExpired" },
      { address: i.sy, abi: syAbi, functionName: "exchangeRate" },
      { address: i.sy, abi: syAbi, functionName: "paused" },
      canPreviewRedeem(i)
        ? { address: i.sy, abi: syAbi, functionName: "previewRedeem", args: [i.yieldToken!.address, 10n ** BigInt(i.sy_.decimals!)] }
        : { address: i.sy, abi: syAbi, functionName: "decimals" },
      { address: PENDLE_CONTRACTS.routerStatic, abi: routerStaticAbi, functionName: "getPtToAssetRate", args: [i.market] },
      { address: PENDLE_CONTRACTS.routerStatic, abi: routerStaticAbi, functionName: "getYtToAssetRate", args: [i.market] },
      { address: PENDLE_CONTRACTS.routerStatic, abi: routerStaticAbi, functionName: "getLpToAssetRate", args: [i.market] },
    ]),
    { blockNumber },
  );
  const out = new Map<string, MarketState>();
  ids.forEach((i, n) => {
    const o = n * PER;
    const errors: string[] = [];
    const g = <T>(k: number, label: string): T | null => {
      const x = r[o + k];
      if (x?.status === "success") return x.result as T;
      errors.push(`${label}: ${x?.status === "failure" ? x.error : "missing"}`);
      return null;
    };
    const st = g<readonly [bigint, bigint, bigint, number, number, number]>(0, "_storage");
    const canPreview = canPreviewRedeem(i);
    out.set(i.market.toLowerCase(), {
      totalPt: st ? st[0] : null,
      totalSy: st ? st[1] : null,
      lastLnImpliedRate: st ? st[2] : null,
      lpTotalSupply: g<bigint>(1, "totalSupply"),
      isExpired: g<boolean>(2, "isExpired"),
      syExchangeRate: g<bigint>(3, "SY.exchangeRate"),
      // Absence of paused() is "unknown", not "not paused".
      syPaused: g<boolean>(4, "SY.paused"),
      yieldTokenPerSy: canPreview ? g<bigint>(5, "SY.previewRedeem") : null,
      ptToAssetRate: g<bigint>(6, "getPtToAssetRate"),
      ytToAssetRate: g<bigint>(7, "getYtToAssetRate"),
      lpToAssetRate: g<bigint>(8, "getLpToAssetRate"),
      errors,
    });
  });
  return out;
}

/** PT, YT and LP balances of `wallet` in each market; null = unreadable. */
export async function readBalances(reader: ChainReader, ids: readonly MarketIdentity[], wallet: Address, blockNumber: bigint): Promise<Map<string, { pt: bigint | null; yt: bigint | null; lp: bigint | null }>> {
  const r = await reader.multicall(
    ids.flatMap((i): ContractCall[] => [
      { address: i.pt, abi: ptAbi, functionName: "balanceOf", args: [wallet] },
      { address: i.yt, abi: ptAbi, functionName: "balanceOf", args: [wallet] },
      { address: i.market, abi: marketAbi, functionName: "balanceOf", args: [wallet] },
    ]),
    { blockNumber },
  );
  return new Map(ids.map((i, n) => [i.market.toLowerCase(), { pt: val<bigint>(r[n * 3]), yt: val<bigint>(r[n * 3 + 1]), lp: val<bigint>(r[n * 3 + 2]) }]));
}
