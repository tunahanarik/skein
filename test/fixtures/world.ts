/**
 * Deterministic offline test world: a small Stock Token registry, Chainlink directory, Robinhood
 * quotes and a fake chain. Values are modelled on live 2026-09-24 data (docs/research/*), but
 * tests never touch the network.
 */
import { getAddress, type Address, type Hex } from "viem";
import type { BlockRef, CallResult, ChainReader, ContractCall, DecodedLog, LogQuery } from "../../src/chain/reader.js";
import type { RpcHealthSnapshot } from "../../src/chain/health.js";
import { CORE_ASSETS, STOCK_TOKEN_REGISTRY } from "../../src/config/assets.js";
import { HttpClient, type FetchLike } from "../../src/lib/http.js";
import { PriceService } from "../../src/pricing/priceService.js";
import { buildFeedIndex, type FeedIndex, type QuoteBook } from "../../src/pricing/sources.js";
import { loadAssetRegistry, type AssetRegistry } from "../../src/registry/registry.js";
import { validateRobinhoodAssetRegistry, type ValidatedRegistry } from "../../src/registry/robinhoodRegistry.js";
import { buildSnapshot, type RegistrySnapshot } from "../../src/registry/snapshot.js";
import type { ChainlinkFeed } from "../../src/sources/chainlink.js";
import type { RhjAsset, RhjQuote } from "../../src/sources/robinhood.js";

export const NOW = new Date("2026-09-24T12:00:00.000Z");
export const NOW_S = Math.floor(NOW.getTime() / 1000);
export const BLOCK: BlockRef = { number: 71_000_000n, hash: `0x${"ab".repeat(32)}` as Hex, timestamp: BigInt(NOW_S) };
export const ONE = 10n ** 18n;

export const WALLET = getAddress("0x1111111111111111111111111111111111111111");
export const WETH = CORE_ASSETS.WETH.address;
export const USDG = CORE_ASSETS.USDG.address;

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const uid = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

export const NVDA = addr(0xa001);
export const AAPL = addr(0xa002);
export const SPLT = addr(0xa003); // a token after a 4:1 split (multiplier 4.0), no Chainlink feed
export const NOFEED = addr(0xa004); // no feed, no quote → unpriced
export const REVERTS = addr(0xa005); // balanceOf reverts
export const UNKNOWN_FAKE_USDG = addr(0xbad1); // not in the registry, claims symbol "USDG"

export const NVDA_MULT = 1000775159164630595n;
export const AAPL_MULT = 1000566080061092436n;

export const FEED_ETH = addr(0xf001);
export const FEED_USDG = addr(0xf002);
export const FEED_NVDA = addr(0xf003);
export const FEED_AAPL = addr(0xf004);

export function rhjAsset(symbol: string, address: Address, id: number, multiplier: string, extra: Partial<RhjAsset> = {}): RhjAsset {
  return {
    id: uid(id),
    tokenSymbol: symbol,
    tokenName: `${symbol} • Robinhood Token`,
    deployments: [{ contractAddress: address, chainId: 4663 }],
    currentMultiplier: multiplier,
    pendingMultiplier: "",
    status: "ASSET_STATUS_ACTIVE",
    tokenDecimals: 18,
    ...extra,
  } as RhjAsset;
}

export const RHJ_ASSETS: RhjAsset[] = [
  rhjAsset("NVDA", NVDA, 1, "1.000775159164630595"),
  rhjAsset("AAPL", AAPL, 2, "1.000566080061092436"),
  rhjAsset("SPLT", SPLT, 3, "4"),
  rhjAsset("NOFD", NOFEED, 4, "1"),
  rhjAsset("RVRT", REVERTS, 5, "1"),
];

export function validated(assets = RHJ_ASSETS, fetchedAt = NOW.toISOString()): ValidatedRegistry {
  return validateRobinhoodAssetRegistry({ assets, url: "fixture", fetchedAt, bytes: 0 });
}

export function baselineSnapshot(assets = RHJ_ASSETS): RegistrySnapshot {
  const v = validated(assets);
  return buildSnapshot(v.entries, NOW.toISOString(), NOW.toISOString());
}

const feed = (name: string, proxy: Address, productTypeCode?: string): ChainlinkFeed =>
  ({
    name,
    path: name.toLowerCase(),
    proxyAddress: proxy,
    decimals: 8,
    heartbeat: 86_400,
    threshold: 0.5,
    ...(productTypeCode ? { docs: { productTypeCode } } : {}),
  }) as ChainlinkFeed;

export const FEEDS: ChainlinkFeed[] = [
  feed("ETH / USD", FEED_ETH),
  feed("USDG / USD", FEED_USDG),
  feed("Robinhood NVDA / USD", FEED_NVDA, "primaryTokenizedPrice"),
  feed("Robinhood AAPL / USD", FEED_AAPL, "primaryTokenizedPrice"),
];

export function quote(symbol: string, address: Address, bid: string, ask: string, extra: Partial<RhjQuote> = {}): RhjQuote {
  return {
    tokenSymbol: symbol,
    bid,
    ask,
    currency: "USD",
    isTradingHalt: false,
    generatedAt: new Date(NOW.getTime() - 5_000).toISOString(),
    deployments: [{ contractAddress: address, chainId: 4663 }],
    ...extra,
  } as RhjQuote;
}

export function quoteBook(quotes: RhjQuote[]): QuoteBook {
  return { byAddress: new Map(quotes.map((q) => [q.deployments![0]!.contractAddress.toLowerCase(), q])), fetchedAt: NOW.toISOString() };
}

export const DEFAULT_QUOTES = [
  quote("NVDA", NVDA, "224.20", "224.22"), // underlying; × NVDA_MULT ≈ 224.38
  quote("AAPL", AAPL, "336.00", "336.10"),
  quote("SPLT", SPLT, "25.00", "25.10"), // underlying 25.05 × 4.0 = 100.20 per token
];

export interface RoundSpec {
  answer: bigint;
  updatedAt: number;
  decimals?: number;
  roundId?: bigint;
  answeredInRound?: bigint;
}

export interface WorldState {
  native: Map<string, bigint>;
  /** token → wallet → balance */
  balances: Map<string, Map<string, bigint>>;
  multipliers: Map<string, bigint | "revert">;
  rounds: Map<string, RoundSpec | "revert">;
  meta: Map<string, { symbol?: string; name?: string; decimals?: number; uid?: Hex; registry?: Address }>;
  revertBalanceOf: Set<string>;
  rpcDown: boolean;
  nativeFails: boolean;
  /** Phase 2: Morpho state (installed by test/fixtures/morpho.ts). */
  morpho?: {
    markets: Map<string, { params: { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint }; totals: { supply: bigint; supplyShares: bigint; borrow: bigint; borrowShares: bigint } }>;
    oracles: Map<string, bigint | "revert">;
    officialVaults: Set<string>;
    vaultTotals: Map<string, bigint>;
    /** `${marketId}:${user}` → position */
    positions: Map<string, { supplyShares: bigint; borrowShares: bigint; collateral: bigint }>;
  };
  /**
   * Phase 3: generic per-contract behaviour, checked before everything else.
   * address → functionName → value, "revert", or a function of the call args.
   */
  contracts?: Map<string, Record<string, unknown | "revert" | ((args: readonly unknown[]) => unknown)>>;
  /** Phase 3: event logs served by getLogs. */
  logs?: { address: string; eventName: string; blockNumber: bigint; logIndex: number; args: Record<string, unknown> }[];
  logsFail?: boolean;
  /** Simulate the provider timing out topic OR-sets larger than this. */
  logsTimeoutAbove?: number;
  /** Count of calls per function name (Phase 2 cache tests). */
  callCounts?: Map<string, number>;
}

export function defaultWorld(): WorldState {
  const w: WorldState = {
    native: new Map([[WALLET.toLowerCase(), 5n * 10n ** 16n]]), // 0.05 ETH
    balances: new Map(),
    multipliers: new Map([
      [NVDA.toLowerCase(), NVDA_MULT],
      [AAPL.toLowerCase(), AAPL_MULT],
      [SPLT.toLowerCase(), 4n * ONE],
      [NOFEED.toLowerCase(), ONE],
      [REVERTS.toLowerCase(), ONE],
    ]),
    rounds: new Map<string, RoundSpec | "revert">([
      [FEED_ETH.toLowerCase(), { answer: 267_926_850_000n, updatedAt: NOW_S - 600 }], // $2,679.2685
      [FEED_USDG.toLowerCase(), { answer: 100_009_000n, updatedAt: NOW_S - 50_000 }], // $1.00009
      [FEED_NVDA.toLowerCase(), { answer: 22_441_382_169n, updatedAt: NOW_S - 300 }], // $224.41382169
      [FEED_AAPL.toLowerCase(), { answer: 33_605_912_874n, updatedAt: NOW_S - 1_200 }],
    ]),
    meta: new Map(),
    revertBalanceOf: new Set([REVERTS.toLowerCase()]),
    rpcDown: false,
    nativeFails: false,
  };
  const bal = (token: Address, amount: bigint) => w.balances.set(token.toLowerCase(), new Map([[WALLET.toLowerCase(), amount]]));
  bal(WETH, 10n ** 17n); // 0.1 WETH
  bal(USDG, 1_234_560_000n); // 1,234.56 USDG
  bal(NVDA, 2n * ONE); // 2 NVDA tokens
  bal(AAPL, 0n);
  bal(SPLT, 3n * ONE);
  bal(NOFEED, ONE);
  // registry identity metadata (for onchain verification)
  for (const a of RHJ_ASSETS) {
    const t = a.deployments[0]!.contractAddress.toLowerCase();
    w.meta.set(t, { symbol: a.tokenSymbol, decimals: 18, uid: a.id as Hex, registry: STOCK_TOKEN_REGISTRY });
  }
  w.meta.set(UNKNOWN_FAKE_USDG.toLowerCase(), { symbol: "USDG", name: "Global Dollar", decimals: 6 });
  w.balances.set(UNKNOWN_FAKE_USDG.toLowerCase(), new Map([[WALLET.toLowerCase(), 5_000_000n]]));
  return w;
}

/** In-memory ChainReader implementing the same contract as ViemChainReader. */
export class FakeChainReader implements ChainReader {
  readonly chainId = 4663;
  calls = 0;
  multicallInvocations = 0;
  constructor(public world: WorldState = defaultWorld()) {}

  health(): RpcHealthSnapshot {
    return {
      endpoint: "fake://",
      requests: this.calls,
      successes: this.calls,
      failures: this.world.rpcDown ? 1 : 0,
      rateLimited: 0,
      timeouts: 0,
      retries: 0,
      avgLatencyMs: 1,
      p95LatencyMs: 1,
      latestBlock: BLOCK.number.toString(),
      lastError: this.world.rpcDown ? "down" : null,
      status: this.world.rpcDown ? "DOWN" : "HEALTHY",
    };
  }
  async assertChainId() {}
  async getLatestBlock() {
    return BLOCK;
  }
  async getNativeBalance(address: Address) {
    this.calls++;
    if (this.world.rpcDown || this.world.nativeFails) throw new Error("rpc down");
    return this.world.native.get(address.toLowerCase()) ?? 0n;
  }
  async readContract(call: ContractCall) {
    const [r] = await this.multicall([call]);
    if (r!.status === "failure") throw new Error(r!.error);
    return r!.result;
  }
  logQueries = 0;
  async getLogs(q: LogQuery): Promise<DecodedLog[]> {
    this.logQueries++;
    if (this.world.rpcDown || this.world.logsFail) throw new Error("eth_getLogs failed");
    const orSize = Math.max(0, ...Object.values(q.args ?? {}).map((v) => (Array.isArray(v) ? v.length : 1)));
    if (this.world.logsTimeoutAbove !== undefined && orSize > this.world.logsTimeoutAbove) throw Object.assign(new Error("An unknown RPC error occurred."), { details: "log query timed out" });
    return (this.world.logs ?? [])
      .filter((l) => l.address.toLowerCase() === q.address.toLowerCase() && l.eventName === q.event.name && l.blockNumber >= q.fromBlock && l.blockNumber <= q.toBlock)
      .filter((l) =>
        Object.entries(q.args ?? {}).every(([k, want]) => {
          const have = String(l.args[k]).toLowerCase();
          return Array.isArray(want) ? want.some((w) => String(w).toLowerCase() === have) : String(want).toLowerCase() === have;
        }),
      )
      .map((l) => ({ address: l.address as Address, blockNumber: l.blockNumber, transactionHash: `0x${"cd".repeat(32)}` as Hex, logIndex: l.logIndex, args: l.args }));
  }
  async multicall(calls: readonly ContractCall[]): Promise<CallResult[]> {
    this.multicallInvocations++;
    this.calls += calls.length;
    if (this.world.rpcDown) return calls.map(() => ({ status: "failure", kind: "RPC", error: "rpc down" }));
    return calls.map((c) => this.one(c));
  }
  private one(c: ContractCall): CallResult {
    const t = c.address.toLowerCase();
    const ok = (result: unknown): CallResult => ({ status: "success", result });
    const revert: CallResult = { status: "failure", kind: "REVERT", error: "execution reverted" };
    const m = this.world.meta.get(t);
    const counts = (this.world.callCounts ??= new Map());
    counts.set(c.functionName, (counts.get(c.functionName) ?? 0) + 1);
    const h = this.world.contracts?.get(t);
    if (h && c.functionName in h) {
      const v = h[c.functionName];
      if (v === "revert") return revert;
      try {
        return ok(typeof v === "function" ? (v as (a: readonly unknown[]) => unknown)(c.args ?? []) : v);
      } catch {
        return revert;
      }
    }
    const mo = this.world.morpho;
    const Z = "0x0000000000000000000000000000000000000000";
    if (mo) {
      switch (c.functionName) {
        case "idToMarketParams": {
          const f = mo.markets.get(String(c.args?.[0]).toLowerCase());
          return ok(f ? [f.params.loanToken, f.params.collateralToken, f.params.oracle, f.params.irm, f.params.lltv] : [Z, Z, Z, Z, 0n]);
        }
        case "market": {
          const f = mo.markets.get(String(c.args?.[0]).toLowerCase());
          return f ? ok([f.totals.supply, f.totals.supplyShares, f.totals.borrow, f.totals.borrowShares, BigInt(NOW_S - 30), 0n]) : ok([0n, 0n, 0n, 0n, 0n, 0n]);
        }
        case "price": {
          const v = mo.oracles.get(t);
          return v === undefined || v === "revert" ? revert : ok(v);
        }
        case "isVaultV2":
          return ok(mo.officialVaults.has(String(c.args?.[0]).toLowerCase()));
        case "totalAssets": {
          const v = mo.vaultTotals.get(t);
          return v === undefined ? revert : ok(v);
        }
        case "position": {
          const pos = mo.positions.get(`${String(c.args?.[0]).toLowerCase()}:${String(c.args?.[1]).toLowerCase()}`);
          return ok(pos ? [pos.supplyShares, pos.borrowShares, pos.collateral] : [0n, 0n, 0n]);
        }
        case "convertToAssets":
          return ok(((c.args?.[0] as bigint) * 105n) / 100n); // 1 share = 1.05 assets in the fixture
      }
    }
    switch (c.functionName) {
      case "balanceOf": {
        if (this.world.revertBalanceOf.has(t)) return revert;
        const byWallet = this.world.balances.get(t);
        if (!byWallet && !m) return revert; // no such contract
        return ok(byWallet?.get(String(c.args?.[0]).toLowerCase()) ?? 0n);
      }
      case "uiMultiplier": {
        const v = this.world.multipliers.get(t);
        return v === undefined || v === "revert" ? revert : ok(v);
      }
      case "decimals": {
        const r = this.world.rounds.get(t);
        if (r && r !== "revert") return ok(r.decimals ?? 8);
        return m?.decimals !== undefined ? ok(m.decimals) : revert;
      }
      case "latestRoundData": {
        const r = this.world.rounds.get(t);
        if (!r || r === "revert") return revert;
        const id = r.roundId ?? 100n;
        return ok([id, r.answer, BigInt(r.updatedAt), BigInt(r.updatedAt), r.answeredInRound ?? id]);
      }
      case "getRoundData": {
        // Deterministic history: each earlier round is 1 h older and 0.1 % lower.
        const r = this.world.rounds.get(t);
        if (!r || r === "revert") return revert;
        const latest = r.roundId ?? 100n;
        const id = BigInt(c.args?.[0] as bigint);
        const back = latest - id;
        if (back <= 0n || back > 1000n) return revert;
        const answer = (r.answer * (1000n - back)) / 1000n;
        const at = BigInt(r.updatedAt) - back * 3600n;
        return ok([id, answer, at, at, id]);
      }
      case "symbol":
        return m?.symbol !== undefined ? ok(m.symbol) : revert;
      case "name":
        return m?.name !== undefined ? ok(m.name) : revert;
      case "uid":
        return m?.uid ? ok(m.uid) : revert;
      case "ACCESS_CONTROLLED_REGISTRY":
        return m?.registry ? ok(m.registry) : revert;
      default:
        return revert;
    }
  }
}

/** Build the full test stack; override any piece per test. */
export async function testStack(
  opts: {
    world?: WorldState;
    assets?: RhjAsset[];
    baseline?: RegistrySnapshot | null;
    liveFails?: boolean;
    quotes?: RhjQuote[] | "fail";
    feeds?: ChainlinkFeed[] | "fail";
    verifyOnchain?: boolean;
    now?: Date;
  } = {},
) {
  const reader = new FakeChainReader(opts.world ?? defaultWorld());
  const http = new HttpClient((() => Promise.reject(new Error("network disabled in tests"))) as FetchLike);
  const now = () => opts.now ?? NOW;
  const registry: AssetRegistry = await loadAssetRegistry({
    http,
    baseline: opts.baseline === undefined ? baselineSnapshot() : opts.baseline,
    loadLive: async () => {
      if (opts.liveFails) throw new Error("HTTP 503");
      return validated(opts.assets ?? RHJ_ASSETS);
    },
    now,
    ...(opts.verifyOnchain ? { reader, blockNumber: BLOCK.number } : {}),
  });
  const prices = new PriceService({
    reader,
    http,
    now,
    loadFeedIndex: async (): Promise<FeedIndex> => {
      if (opts.feeds === "fail") throw new Error("directory down");
      return buildFeedIndex(opts.feeds ?? FEEDS, NOW.toISOString());
    },
    loadQuoteBook: async () => {
      if (opts.quotes === "fail") throw new Error("quotes down");
      return quoteBook(opts.quotes ?? DEFAULT_QUOTES);
    },
  });
  return { reader, http, registry, prices, now, deps: { reader, getRegistry: async () => registry, prices, now } };
}
