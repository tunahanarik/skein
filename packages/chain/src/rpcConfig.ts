import { PUBLIC_RPC_URL } from "@skein/networks/chains";

export type RuntimeMode = "production" | "development" | "test";

export interface RpcConfig {
  url: string;
  isPublicRpc: boolean;
  /**
   * Optional separate endpoint for eth_getLogs indexing (ROBINHOOD_INDEX_RPC_URL), e.g. an
   * archive/indexing-capable plan. Falls back to `url`.
   */
  indexUrl?: string;
  /** Calls per Multicall3 aggregate3 request. */
  multicallChunkSize: number;
  /** Attempts per request (1 = no retry). */
  maxAttempts: number;
  timeoutMs: number;
  /** Base backoff; rate-limit responses back off longer. */
  retryBaseMs: number;
  /**
   * Minimum spacing between eth_getLogs requests. The public RPC answers 429 after a burst of
   * ~6 log queries and sustains about 1/s (measured 2026-09-24); keyed providers need none.
   */
  logMinIntervalMs?: number;
}

export class RpcConfigError extends Error {
  override readonly name = "RpcConfigError";
}

export const RPC_DEFAULTS = {
  multicallChunkSize: 400,
  maxAttempts: 4,
  timeoutMs: 20_000,
  retryBaseMs: 600,
  /** Public RPC only (see RpcConfig.logMinIntervalMs). */
  publicLogMinIntervalMs: 1_000,
} as const;

/**
 * Resolve the RPC endpoint. Production must use a dedicated provider: the public endpoint is
 * officially "Rate-Limited, Not for Production" (docs.robinhood.com/chain/connecting).
 */
export function resolveRpcConfig(env: Record<string, string | undefined>, mode: RuntimeMode): RpcConfig {
  const configured = env.ROBINHOOD_RPC_URL?.trim();
  const url = configured || PUBLIC_RPC_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RpcConfigError("ROBINHOOD_RPC_URL is not a valid URL");
  }
  if (parsed.protocol !== "https:" && !(mode !== "production" && parsed.hostname === "localhost")) {
    throw new RpcConfigError("RPC URL must use https");
  }
  const isPublicRpc = parsed.host === new URL(PUBLIC_RPC_URL).host;
  if (mode === "production" && !configured) {
    throw new RpcConfigError("production requires ROBINHOOD_RPC_URL (a dedicated provider); none is set");
  }
  if (mode === "production" && isPublicRpc) {
    throw new RpcConfigError("production requires a dedicated RPC provider (set ROBINHOOD_RPC_URL); the public RPC is not for production");
  }
  const indexConfigured = env.ROBINHOOD_INDEX_RPC_URL?.trim();
  let indexUrl: string | undefined;
  if (indexConfigured) {
    let ip: URL;
    try {
      ip = new URL(indexConfigured);
    } catch {
      throw new RpcConfigError("ROBINHOOD_INDEX_RPC_URL is not a valid URL");
    }
    if (ip.protocol !== "https:" && !(mode !== "production" && ip.hostname === "localhost")) throw new RpcConfigError("index RPC URL must use https");
    if (mode === "production" && ip.host === new URL(PUBLIC_RPC_URL).host) throw new RpcConfigError("production index RPC must not be the public RPC");
    indexUrl = indexConfigured;
  }
  const num = (key: string, fallback: number, min: number, max: number) => {
    const v = env[key];
    if (v === undefined || v === "") return fallback;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new RpcConfigError(`${key} must be an integer in [${min}, ${max}]`);
    return n;
  };
  return {
    url,
    isPublicRpc,
    ...(indexUrl ? { indexUrl } : {}),
    multicallChunkSize: num("RPC_MULTICALL_CHUNK_SIZE", RPC_DEFAULTS.multicallChunkSize, 1, 2_000),
    maxAttempts: num("RPC_MAX_ATTEMPTS", RPC_DEFAULTS.maxAttempts, 1, 10),
    timeoutMs: num("RPC_TIMEOUT_MS", RPC_DEFAULTS.timeoutMs, 1_000, 120_000),
    retryBaseMs: num("RPC_RETRY_BASE_MS", RPC_DEFAULTS.retryBaseMs, 0, 30_000),
    logMinIntervalMs: num("RPC_LOG_MIN_INTERVAL_MS", isPublicRpc ? RPC_DEFAULTS.publicLogMinIntervalMs : 0, 0, 60_000),
  };
}

export function runtimeMode(env: Record<string, string | undefined>): RuntimeMode {
  const m = env.APP_ENV ?? env.NODE_ENV;
  return m === "production" ? "production" : m === "test" ? "test" : "development";
}
