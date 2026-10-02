/**
 * ChainReader: the only way engine code talks to Robinhood Chain. Read-only by construction —
 * the interface has no method that signs or sends. The viem implementation can point at any
 * provider (Alchemy, QuickNode, public RPC) via RpcConfig.
 */
import {
  createPublicClient,
  http,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ROBINHOOD_CHAIN_ID, robinhoodChain } from "@skein/networks/chains";
import { RpcHealth, type RpcHealthSnapshot, type RpcOutcome } from "./health.js";
import type { RpcConfig } from "./rpcConfig.js";

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/**
 * Per-call result. REVERT = the call itself failed inside Multicall3 (e.g. the token reverted);
 * RPC = the whole request failed after retries (rate limit, timeout, provider error).
 */
export type CallResult =
  | { status: "success"; result: unknown }
  | { status: "failure"; kind: "REVERT" | "RPC"; error: string };

export interface BlockRef {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
}

export interface LogQuery {
  address: Address;
  event: AbiEvent;
  fromBlock: bigint;
  toBlock: bigint;
  /** Indexed-argument filter (topics). An array value means "any of" (OR). */
  args?: Record<string, unknown>;
  /**
   * Do not bisect the block range on range/timeout errors; throw instead. For callers that split
   * differently (e.g. by topic set), because a timed-out wide topic OR-set is not fixed by halving
   * the range — each half re-scans the same set (measured 2026-09-24).
   */
  noRangeSplit?: boolean;
}

export interface DecodedLog {
  address: Address;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  args: Record<string, unknown>;
}

/** Deepest range bisection for eth_getLogs (2^16 sub-ranges) before giving up. */
export const MAX_LOG_SPLIT_DEPTH = 16;
/** Hard budget of eth_getLogs sub-requests for ONE getLogs call; beyond it the call fails. */
export const MAX_LOG_SUBREQUESTS = 512;

/** Full error text including the provider's details (viem puts them in `details` and later lines). */
function errorText(e: unknown): string {
  const err = e as { message?: string; details?: string; detail?: string; cause?: unknown };
  const own = `${err?.message ?? ""} ${err?.details ?? ""} ${err?.detail ?? ""}`;
  return err?.cause && err.cause !== e ? `${own} ${errorText(err.cause)}` : own;
}

/**
 * Provider errors that mean "range/result set too large", which bisection can fix. Includes
 * Robinhood Chain's "logs matched by query exceeds limit of 10000" and "log query timed out"
 * (observed 2026-09-24 for wide ranges or large topic OR-sets).
 */
export function isLogRangeError(e: unknown): boolean {
  return /more than \d+ results|query returned more than|block range|range (is )?too (large|wide)|limit exceeded|exceeds limit|too many (logs|results)|log query timed out/i.test(errorText(e));
}

/** viem error classes that mean the REQUEST failed (transport/provider), not that a call reverted. */
const TRANSPORT_ERROR_NAMES = new Set(["HttpRequestError", "RpcRequestError", "UnknownRpcError", "InternalRpcError", "LimitExceededRpcError", "TimeoutError", "WebSocketRequestError", "SocketClosedError"]);

/**
 * True when a multicall per-call failure is really a transport failure of the whole aggregate
 * request. viem's `multicall({ allowFailure: true })` folds a failed aggregate3 eth_call into one
 * failure per call (observed 2026-09-24 under public-RPC rate limiting: "An unknown RPC error
 * occurred" on every call of a chunk), which would otherwise bypass retry and look like reverts.
 */
export function isTransportFailure(e: unknown): boolean {
  for (let cur = e as { name?: string; cause?: unknown } | undefined, depth = 0; cur && depth < 8; cur = cur.cause as typeof cur, depth++) {
    if (cur.name && TRANSPORT_ERROR_NAMES.has(cur.name)) return true;
  }
  const outcome = classifyRpcError(e);
  return outcome === "RATE_LIMITED" || outcome === "TIMEOUT";
}

export interface ChainReader {
  readonly chainId: number;
  /** Throws unless the endpoint really is Robinhood Chain (eth_chainId). */
  assertChainId(): Promise<void>;
  getLatestBlock(): Promise<BlockRef>;
  getNativeBalance(address: Address, blockNumber: bigint): Promise<bigint>;
  /** Order-preserving; never throws for individual call failures. */
  multicall(calls: readonly ContractCall[], opts: { blockNumber: bigint }): Promise<CallResult[]>;
  readContract(call: ContractCall, opts: { blockNumber: bigint }): Promise<unknown>;
  /**
   * Decoded event logs of ONE event from ONE contract, ordered by (block, logIndex). Ranges the
   * provider rejects as too large are bisected; any other failure throws (no partial list).
   */
  getLogs(q: LogQuery): Promise<DecodedLog[]>;
  health(): RpcHealthSnapshot;
}

export class RpcRequestError extends Error {
  override readonly name = "RpcRequestError";
  constructor(message: string, readonly outcome: RpcOutcome, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export function classifyRpcError(e: unknown): RpcOutcome {
  const err = e as { name?: string; status?: number; message?: string; cause?: unknown };
  // Full text incl. provider details and causes: viem wraps HTTP 429 as "unknown RPC error"
  // with "Too Many Requests" only in its details (observed 2026-09-24).
  const text = `${err?.name ?? ""} ${errorText(e)}`;
  const causeStatus = (err?.cause as { status?: number } | undefined)?.status;
  // "reading 'error'": viem's batch parser crashing on the non-JSON-RPC body the public RPC returns
  // when it rate-limits a batch (observed 2026-09-24) — retried with rate-limit backoff.
  if (err?.status === 429 || causeStatus === 429 || /\b429\b|too many requests|rate limit|reading 'error'/i.test(text)) return "RATE_LIMITED";
  if (/timeout|timed out|TimeoutError|aborted/i.test(text)) return "TIMEOUT";
  return "ERROR";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ViemChainReader implements ChainReader {
  readonly chainId = ROBINHOOD_CHAIN_ID;
  private readonly client: PublicClient;
  /**
   * eth_getLogs goes through an UNBATCHED client: a heavy log query inside a JSON-RPC batch can
   * make the provider answer with a non-standard error body that viem cannot parse
   * ("Cannot read properties of undefined (reading 'error')", observed 2026-09-24). Log responses
   * are large, so batching them gains nothing.
   */
  private readonly logClient: PublicClient;
  private readonly healthState: RpcHealth;
  private lastLogRequestAt = 0;

  /** `client` is injectable for tests; production builds it from `config`. */
  constructor(
    private readonly config: RpcConfig,
    client?: PublicClient,
  ) {
    this.healthState = new RpcHealth(config.url);
    this.client = client ?? createPublicClient({
      chain: robinhoodChain,
      // Retries are handled here (not by viem) so every attempt is visible to RpcHealth.
      transport: http(config.url, { batch: { batchSize: 10, wait: 20 }, retryCount: 0, timeout: config.timeoutMs }),
    });
    this.logClient = client ?? createPublicClient({ chain: robinhoodChain, transport: http(config.indexUrl ?? config.url, { retryCount: 0, timeout: config.timeoutMs }) });
  }

  health(): RpcHealthSnapshot {
    return this.healthState.snapshot();
  }

  /** Run one RPC operation with timing, classification and bounded retry. */
  private async withRetry<T>(label: string, op: () => Promise<T>, isRetriable: (e: unknown) => boolean = () => true): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      const t0 = performance.now();
      try {
        const v = await op();
        this.healthState.record("SUCCESS", performance.now() - t0);
        return v;
      } catch (e) {
        const outcome = classifyRpcError(e);
        this.healthState.record(outcome, performance.now() - t0, `${label}: ${(e as Error).message?.split("\n")[0] ?? outcome}`);
        lastErr = e;
        if (!isRetriable(e) || attempt === this.config.maxAttempts) break;
        this.healthState.recordRetry();
        const base = outcome === "RATE_LIMITED" ? this.config.retryBaseMs * 3 : this.config.retryBaseMs;
        await sleep(base * attempt);
      }
    }
    const outcome = classifyRpcError(lastErr);
    // The original error stays attached as `cause` (callers such as getLogs classify on its details).
    throw new RpcRequestError(`${label} failed: ${(lastErr as Error)?.message?.split("\n")[0] ?? "unknown"}`, outcome, lastErr);
  }

  async assertChainId(): Promise<void> {
    const id = await this.withRetry("eth_chainId", () => this.client.getChainId());
    if (id !== ROBINHOOD_CHAIN_ID) throw new RpcRequestError(`RPC is chain ${id}, expected ${ROBINHOOD_CHAIN_ID}`, "ERROR");
  }

  async getLatestBlock(): Promise<BlockRef> {
    const b = await this.withRetry("eth_getBlockByNumber", () => this.client.getBlock({ blockTag: "latest" }));
    this.healthState.observeBlock(b.number);
    return { number: b.number, hash: b.hash, timestamp: b.timestamp };
  }

  getNativeBalance(address: Address, blockNumber: bigint): Promise<bigint> {
    return this.withRetry("eth_getBalance", () => this.client.getBalance({ address, blockNumber }));
  }

  async readContract(call: ContractCall, opts: { blockNumber: bigint }): Promise<unknown> {
    // A revert is deterministic; retrying it only burns rate limit.
    return this.withRetry(
      `eth_call ${call.functionName}`,
      () => this.client.readContract({ ...call, args: call.args ?? [], blockNumber: opts.blockNumber } as never),
      (e) => classifyRpcError(e) !== "ERROR" || !/revert/i.test((e as Error).message ?? ""),
    );
  }

  async getLogs(q: LogQuery): Promise<DecodedLog[]> {
    let budget = MAX_LOG_SUBREQUESTS;
    const run = async (from: bigint, to: bigint, depth: number): Promise<DecodedLog[]> => {
      if (--budget < 0) throw new RpcRequestError(`eth_getLogs ${q.event.name}: more than ${MAX_LOG_SUBREQUESTS} sub-requests; aborting (no partial list)`, "ERROR");
      // Pace log queries (rate limits apply per request, not per call site).
      const gap = (this.config.logMinIntervalMs ?? 0) - (Date.now() - this.lastLogRequestAt);
      if (gap > 0) await sleep(gap);
      this.lastLogRequestAt = Date.now();
      try {
        const logs = await this.withRetry(
          `eth_getLogs ${q.event.name} [${from}..${to}]`,
          () => this.logClient.getLogs({ address: q.address, event: q.event, ...(q.args ? { args: q.args } : {}), fromBlock: from, toBlock: to, strict: true } as never),
          (e) => !isLogRangeError(e) && classifyRpcError(e) !== "ERROR",
        );
        return (logs as unknown as { address: Address; blockNumber: bigint; transactionHash: Hex; logIndex: number; args: Record<string, unknown> }[]).map((l) => ({
          address: l.address,
          blockNumber: l.blockNumber,
          transactionHash: l.transactionHash,
          logIndex: l.logIndex,
          args: l.args,
        }));
      } catch (e) {
        if (!q.noRangeSplit && to > from && depth < MAX_LOG_SPLIT_DEPTH && isLogRangeError(e)) {
          const mid = from + (to - from) / 2n;
          return [...(await run(from, mid, depth + 1)), ...(await run(mid + 1n, to, depth + 1))];
        }
        throw e;
      }
    };
    const out = await run(q.fromBlock, q.toBlock, 0);
    return out.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  }

  async multicall(calls: readonly ContractCall[], opts: { blockNumber: bigint }): Promise<CallResult[]> {
    const out: CallResult[] = new Array(calls.length);
    const size = this.config.multicallChunkSize;
    for (let start = 0; start < calls.length; start += size) {
      const chunk = calls.slice(start, start + size);
      try {
        const res = await this.withRetry(`multicall[${start}..${start + chunk.length})`, async () => {
          const r = await this.client.multicall({
            contracts: chunk.map((c) => ({ ...c, args: c.args ?? [] })) as never,
            allowFailure: true,
            blockNumber: opts.blockNumber,
            batchSize: 0, // chunking is done above, by call count
          });
          // A transport failure folded into per-call results: rethrow so the chunk is retried.
          const t = (r as { status: string; error?: unknown }[]).find((x) => x.status === "failure" && isTransportFailure(x.error));
          if (t) throw t.error;
          return r;
        });
        (res as { status: "success" | "failure"; result?: unknown; error?: Error }[]).forEach((r, i) => {
          out[start + i] =
            r.status === "success"
              ? { status: "success", result: r.result }
              : { status: "failure", kind: "REVERT", error: r.error?.message?.split("\n")[0] ?? "reverted" };
        });
      } catch (e) {
        // The chunk failed as a whole: mark each call, keep going with the next chunk.
        const msg = (e as Error).message;
        chunk.forEach((_, i) => {
          out[start + i] = { status: "failure", kind: "RPC", error: msg };
        });
      }
    }
    return out;
  }
}
