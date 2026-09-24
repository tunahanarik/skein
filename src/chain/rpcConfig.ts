import { PUBLIC_RPC_URL } from "../config/chains.js";

export type RuntimeMode = "production" | "development" | "test";

export interface RpcConfig {
  url: string;
  isPublicRpc: boolean;
  /** Calls per Multicall3 aggregate3 request. */
  multicallChunkSize: number;
  /** Attempts per request (1 = no retry). */
  maxAttempts: number;
  timeoutMs: number;
  /** Base backoff; rate-limit responses back off longer. */
  retryBaseMs: number;
}

export class RpcConfigError extends Error {
  override readonly name = "RpcConfigError";
}

export const RPC_DEFAULTS = {
  multicallChunkSize: 400,
  maxAttempts: 4,
  timeoutMs: 20_000,
  retryBaseMs: 600,
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
  if (mode === "production" && isPublicRpc) {
    throw new RpcConfigError("production requires a dedicated RPC provider (set ROBINHOOD_RPC_URL); the public RPC is not for production");
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
    multicallChunkSize: num("RPC_MULTICALL_CHUNK_SIZE", RPC_DEFAULTS.multicallChunkSize, 1, 2_000),
    maxAttempts: num("RPC_MAX_ATTEMPTS", RPC_DEFAULTS.maxAttempts, 1, 10),
    timeoutMs: num("RPC_TIMEOUT_MS", RPC_DEFAULTS.timeoutMs, 1_000, 120_000),
    retryBaseMs: num("RPC_RETRY_BASE_MS", RPC_DEFAULTS.retryBaseMs, 0, 30_000),
  };
}

export function runtimeMode(env: Record<string, string | undefined>): RuntimeMode {
  const m = env.APP_ENV ?? env.NODE_ENV;
  return m === "production" ? "production" : m === "test" ? "test" : "development";
}
