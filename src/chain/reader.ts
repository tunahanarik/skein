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
import { ROBINHOOD_CHAIN_ID, robinhoodChain } from "../config/chains.js";
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

/** Provider errors that mean "range/result set too large", which bisection can fix. */
export function isLogRangeError(e: unknown): boolean {
  return /more than \d+ results|query returned more than|block range|range (is )?too (large|wide)|limit exceeded|too many (logs|results)|10000/i.test((e as Error)?.message ?? "");
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
  constructor(message: string, readonly outcome: RpcOutcome) {
    super(message);
  }
}

export function classifyRpcError(e: unknown): RpcOutcome {
  const err = e as { name?: string; status?: number; message?: string; cause?: unknown };
  const text = `${err?.name ?? ""} ${err?.message ?? ""} ${String((err?.cause as { message?: string })?.message ?? "")}`;
  if (err?.status === 429 || /\b429\b|too many requests|rate limit/i.test(text)) return "RATE_LIMITED";
  if (/timeout|timed out|TimeoutError|aborted/i.test(text)) return "TIMEOUT";
  return "ERROR";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ViemChainReader implements ChainReader {
  readonly chainId = ROBINHOOD_CHAIN_ID;
  private readonly client: PublicClient;
  private readonly healthState: RpcHealth;

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
    throw new RpcRequestError(`${label} failed: ${(lastErr as Error)?.message?.split("\n")[0] ?? "unknown"}`, outcome);
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
    const run = async (from: bigint, to: bigint, depth: number): Promise<DecodedLog[]> => {
      try {
        const logs = await this.withRetry(
          `eth_getLogs ${q.event.name} [${from}..${to}]`,
          () => this.client.getLogs({ address: q.address, event: q.event, fromBlock: from, toBlock: to, strict: true } as never),
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
        if (to > from && depth < MAX_LOG_SPLIT_DEPTH && isLogRangeError(e)) {
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
        const res = await this.withRetry(`multicall[${start}..${start + chunk.length})`, () =>
          this.client.multicall({
            contracts: chunk.map((c) => ({ ...c, args: c.args ?? [] })) as never,
            allowFailure: true,
            blockNumber: opts.blockNumber,
            batchSize: 0, // chunking is done above, by call count
          }),
        );
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
