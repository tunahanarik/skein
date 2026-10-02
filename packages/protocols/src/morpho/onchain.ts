/**
 * Onchain reads against Morpho (Blue) on Robinhood Chain, all batched through the ChainReader
 * (Multicall3) at one pinned block. Formulas mirror morpho-blue v1 (SharesMathLib, Morpho.sol).
 */
import { encodeAbiParameters, keccak256, parseAbi, type Address, type Hex } from "viem";
import type { ChainReader } from "@skein/chain/reader";
import { mulDivDown, mulDivUp, WAD, wMulDown } from "@skein/core/lib/fixed";

// docs.morpho.org/developers/contracts/addresses (Robinhood Chain) + morpho-org/sdks addresses.ts
export const MORPHO_ADDRESS: Address = "0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010";
/** morpho-blue ConstantsLib.sol */
export const ORACLE_PRICE_SCALE = 10n ** 36n;
export const LIQUIDATION_CURSOR = 3n * 10n ** 17n; // 0.3e18
export const MAX_LIQUIDATION_INCENTIVE_FACTOR = 115n * 10n ** 16n; // 1.15e18
/** SharesMathLib.sol */
export const VIRTUAL_SHARES = 10n ** 6n;
export const VIRTUAL_ASSETS = 1n;

export const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
]);
export const oracleAbi = parseAbi(["function price() view returns (uint256)"]);
export const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
]);

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface MarketTotals {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

/** Morpho market id = keccak256(abi.encode(MarketParams)). */
export function marketIdOf(p: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv]),
  );
}

/** Morpho.sol liquidate(): min(1.15, 1 / (1 − 0.3 × (1 − LLTV))), Fixed18. */
export function liquidationIncentiveFactor(lltv: bigint): bigint {
  const denom = WAD - wMulDown(LIQUIDATION_CURSOR, WAD - lltv);
  const lif = mulDivDown(WAD, WAD, denom); // WAD.wDivDown(denom)
  return lif < MAX_LIQUIDATION_INCENTIVE_FACTOR ? lif : MAX_LIQUIDATION_INCENTIVE_FACTOR;
}

export const toAssetsDown = (shares: bigint, totalAssets: bigint, totalShares: bigint) => mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
export const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint) => mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);

/** Morpho._isHealthy: maxBorrow = collateral × price / 1e36 × LLTV (floors); healthy iff maxBorrow ≥ borrowed. */
export function maxBorrowAssets(collateral: bigint, oraclePrice: bigint, lltv: bigint): bigint {
  return wMulDown(mulDivDown(collateral, oraclePrice, ORACLE_PRICE_SCALE), lltv);
}

export interface OnchainMarket {
  id: Hex;
  params: MarketParams | null;
  paramsError: string | null;
  totals: MarketTotals | null;
  totalsError: string | null;
}

export async function readMarkets(reader: ChainReader, ids: readonly Hex[], blockNumber: bigint, withParams: ReadonlySet<Hex>): Promise<Map<Hex, OnchainMarket>> {
  const calls = ids.flatMap((id) => [
    ...(withParams.has(id) ? [{ address: MORPHO_ADDRESS, abi: morphoAbi, functionName: "idToMarketParams", args: [id] }] : []),
    { address: MORPHO_ADDRESS, abi: morphoAbi, functionName: "market", args: [id] },
  ]);
  const res = await reader.multicall(calls, { blockNumber });
  const out = new Map<Hex, OnchainMarket>();
  let i = 0;
  for (const id of ids) {
    const m: OnchainMarket = { id, params: null, paramsError: null, totals: null, totalsError: null };
    if (withParams.has(id)) {
      const r = res[i++];
      if (r?.status === "success") {
        const [loanToken, collateralToken, oracle, irm, lltv] = r.result as readonly [Address, Address, Address, Address, bigint];
        m.params = { loanToken, collateralToken, oracle, irm, lltv };
      } else m.paramsError = r?.status === "failure" ? r.error : "missing";
    }
    const t = res[i++];
    if (t?.status === "success") {
      const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee] = t.result as readonly bigint[];
      m.totals = { totalSupplyAssets: totalSupplyAssets!, totalSupplyShares: totalSupplyShares!, totalBorrowAssets: totalBorrowAssets!, totalBorrowShares: totalBorrowShares!, lastUpdate: lastUpdate!, fee: fee! };
    } else m.totalsError = t?.status === "failure" ? t.error : "missing";
    out.set(id, m);
  }
  return out;
}

export async function readOraclePrices(reader: ChainReader, oracles: readonly Address[], blockNumber: bigint): Promise<Map<string, bigint | null>> {
  const unique = [...new Set(oracles.map((o) => o.toLowerCase()))] as Address[];
  const res = await reader.multicall(unique.map((address) => ({ address, abi: oracleAbi, functionName: "price" })), { blockNumber });
  return new Map(unique.map((o, i) => [o, res[i]?.status === "success" ? (res[i].result as bigint) : null]));
}

export async function readVaultTotals(reader: ChainReader, vaults: readonly Address[], blockNumber: bigint): Promise<Map<string, bigint | null>> {
  const res = await reader.multicall(vaults.map((address) => ({ address, abi: vaultAbi, functionName: "totalAssets" })), { blockNumber });
  return new Map(vaults.map((v, i) => [v.toLowerCase(), res[i]?.status === "success" ? (res[i].result as bigint) : null]));
}

export interface OnchainPosition {
  id: Hex;
  supplyShares: bigint;
  borrowShares: bigint;
  collateral: bigint;
}

/** position(id, user) for every market; returns only non-empty positions plus unreadable ids. */
export async function readPositions(reader: ChainReader, ids: readonly Hex[], user: Address, blockNumber: bigint): Promise<{ positions: OnchainPosition[]; unreadable: Hex[] }> {
  const res = await reader.multicall(ids.map((id) => ({ address: MORPHO_ADDRESS, abi: morphoAbi, functionName: "position", args: [id, user] })), { blockNumber });
  const positions: OnchainPosition[] = [];
  const unreadable: Hex[] = [];
  ids.forEach((id, i) => {
    const r = res[i];
    if (r?.status !== "success") return void unreadable.push(id);
    const [supplyShares, borrowShares, collateral] = r.result as readonly [bigint, bigint, bigint];
    if (supplyShares > 0n || borrowShares > 0n || collateral > 0n) positions.push({ id, supplyShares, borrowShares, collateral });
  });
  return { positions, unreadable };
}

export async function readVaultShares(reader: ChainReader, vaults: readonly Address[], user: Address, blockNumber: bigint): Promise<{ held: Map<string, { shares: bigint; assets: bigint | null }>; unreadable: Address[] }> {
  const bal = await reader.multicall(vaults.map((address) => ({ address, abi: vaultAbi, functionName: "balanceOf", args: [user] })), { blockNumber });
  const unreadable: Address[] = [];
  const nonZero: { vault: Address; shares: bigint }[] = [];
  vaults.forEach((vault, i) => {
    const r = bal[i];
    if (r?.status !== "success") return void unreadable.push(vault);
    const shares = r.result as bigint;
    if (shares > 0n) nonZero.push({ vault, shares });
  });
  const conv = await reader.multicall(nonZero.map((h) => ({ address: h.vault, abi: vaultAbi, functionName: "convertToAssets", args: [h.shares] })), { blockNumber });
  const held = new Map<string, { shares: bigint; assets: bigint | null }>();
  nonZero.forEach((h, i) => held.set(h.vault.toLowerCase(), { shares: h.shares, assets: conv[i]?.status === "success" ? (conv[i].result as bigint) : null }));
  return { held, unreadable };
}
