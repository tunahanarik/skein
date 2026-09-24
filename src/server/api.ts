/**
 * Read-only HTTP API over the Phase 5 product service (docs/api.md). No framework: node:http.
 *
 *   GET /api/health                                   RPC health (endpoint redacted), chain id
 *   GET /api/assets                                   canonical asset list (search / picker)
 *   GET /api/assets/:ref?mode=&to=&amount=            AssetIntelligence (ref = symbol, address or key)
 *   GET /api/portfolio/:address?mode=                 PortfolioIntelligence (never cached, never logged)
 *   GET /api/coverage                                 coverage matrix
 *
 * Only GET/HEAD. Every input is validated; errors never carry stack traces. Request logs carry
 * the route TEMPLATE, never the raw path (a wallet address is part of the portfolio path).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAddress } from "viem";
import type { RpcHealthSnapshot } from "../chain/health.js";
import type { AssetRegistry } from "../registry/registry.js";
import type { AssetIntelligenceService } from "../product/service.js";
import type { ProductMode } from "../product/types.js";
import { RateLimiter } from "./rateLimit.js";
import { sendJson } from "./json.js";
import type { AssetListItem, Wire } from "./wire.js";

export interface ApiDeps {
  intelligence: AssetIntelligenceService;
  getRegistry: () => Promise<AssetRegistry>;
  health: () => RpcHealthSnapshot;
  chainId: number;
  /** Structured request log sink (route template, status, ms). Default: stdout. */
  log?: (line: Record<string, unknown>) => void;
  now?: () => number;
  /** Trust X-Forwarded-For for rate limiting (only behind a known proxy). */
  trustProxy?: boolean;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Requests per minute per client IP. Expensive = quotes, portfolio, DEBUG, coverage. */
export const RATE_LIMITS = { general: 120, expensive: 20 } as const;

const MAX_AMOUNT_LEN = 40;
const SYMBOL = /^[A-Za-z0-9.\-]{1,16}$/;

export type { AssetListItem } from "./wire.js";

function parseMode(v: string | null): ProductMode {
  if (v === null || v === "" || v.toLowerCase() === "product") return "PRODUCT";
  if (v.toLowerCase() === "debug") return "DEBUG";
  throw new ApiError(400, "BAD_MODE", "mode must be product or debug");
}

/** symbol | 0x-address | 4663:0x-key → registry key of a registry asset. */
export function resolveRef(registry: AssetRegistry, ref: string, chainId: number): string {
  const r = ref.trim();
  const addr = r.includes(":") ? r.split(":")[1] ?? "" : r;
  if (/^0x/i.test(addr)) {
    if (!isAddress(addr, { strict: false })) throw new ApiError(400, "BAD_ADDRESS", "not a valid address");
    const a = registry.get(chainId, addr.toLowerCase() as `0x${string}`);
    if (!a) throw new ApiError(404, "UNKNOWN_ASSET", "asset is not in the registry");
    return a.key;
  }
  if (!SYMBOL.test(r)) throw new ApiError(400, "BAD_ASSET", "asset must be a symbol, address or registry key");
  const hits = registry.canonicalBySymbol(r);
  if (hits.length === 0) throw new ApiError(404, "UNKNOWN_ASSET", "no canonical asset with this symbol");
  if (hits.length > 1) throw new ApiError(409, "AMBIGUOUS_SYMBOL", "symbol matches several canonical assets; use the address");
  return hits[0]!.key;
}

export function createApi(deps: ApiDeps) {
  const log = deps.log ?? ((l: Record<string, unknown>) => console.log(JSON.stringify(l)));
  const limiter = new RateLimiter(deps.now ?? (() => Date.now()));
  let assetList: { at: number; body: AssetListItem[] } | null = null;

  const clientIp = (req: IncomingMessage) => {
    if (deps.trustProxy) {
      const fwd = req.headers["x-forwarded-for"];
      const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? "unknown";
  };

  async function route(req: IncomingMessage, url: URL): Promise<{ template: string; status?: number; body: unknown; cache: string; expensive: boolean }> {
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams;
    if (p === "/api/health") {
      const h = deps.health();
      return { template: "/api/health", body: { chainId: deps.chainId, rpc: h, readOnly: true }, cache: "no-store", expensive: false };
    }
    if (p === "/api/assets") {
      const now = (deps.now ?? Date.now)();
      if (!assetList || now - assetList.at > 5 * 60_000) {
        const reg = await deps.getRegistry();
        assetList = {
          at: now,
          body: reg
            .canonical()
            .filter((a) => a.address)
            .map((a) => ({ key: a.key, symbol: a.symbol, name: a.name, type: a.type, address: a.address!, decimals: a.decimals }))
            .sort((a, b) => a.symbol.localeCompare(b.symbol)),
        };
      }
      return { template: "/api/assets", body: { assets: assetList.body }, cache: "public, max-age=300", expensive: false };
    }
    if (p === "/api/coverage") {
      return { template: "/api/coverage", body: { rows: await deps.intelligence.getCoverage() }, cache: "public, max-age=15", expensive: true };
    }
    let m = /^\/api\/assets\/([^/]{1,100})$/.exec(p);
    if (m) {
      const reg = await deps.getRegistry();
      const key = resolveRef(reg, decodeURIComponent(m[1]!), deps.chainId);
      const mode = parseMode(q.get("mode"));
      const to = q.get("to");
      const amount = q.get("amount");
      if (amount !== null && (amount.length > MAX_AMOUNT_LEN || !/^\d+(\.\d+)?$/.test(amount) || /^0+(\.0+)?$/.test(amount))) throw new ApiError(400, "BAD_AMOUNT", "amount must be a positive decimal number");
      if (amount !== null && !to) throw new ApiError(400, "AMOUNT_NEEDS_TARGET", "amount requires a trade target (to)");
      const tradeTarget = to ? resolveRef(reg, to, deps.chainId) : undefined;
      if (tradeTarget === key) throw new ApiError(400, "SAME_ASSET", "trade target must differ from the asset");
      const v = await deps.intelligence.getAssetIntelligence(key, { mode, ...(tradeTarget ? { tradeTarget } : {}), ...(amount !== null ? { tradeAmount: amount } : {}) });
      return { template: "/api/assets/:ref", body: v, cache: amount !== null ? "no-store" : "public, max-age=10", expensive: amount !== null || mode === "DEBUG" };
    }
    m = /^\/api\/portfolio\/([^/]{1,100})$/.exec(p);
    if (m) {
      const addr = decodeURIComponent(m[1]!);
      if (!isAddress(addr, { strict: false })) throw new ApiError(400, "BAD_ADDRESS", "not a valid wallet address");
      const v = await deps.intelligence.getPortfolioIntelligence(addr, { mode: parseMode(q.get("mode")) });
      return { template: "/api/portfolio/:address", body: v, cache: "no-store", expensive: true };
    }
    throw new ApiError(404, "NOT_FOUND", "no such endpoint");
  }

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = performance.now();
    let template = "unmatched";
    let status = 200;
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        throw new ApiError(405, "METHOD_NOT_ALLOWED", "read-only API: GET only");
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const ip = clientIp(req);
      // Cheap pre-check so a flood never reaches the engine.
      if (!limiter.take(`g:${ip}`, RATE_LIMITS.general)) throw new ApiError(429, "RATE_LIMITED", "too many requests");
      const expensive = url.pathname.startsWith("/api/portfolio") || url.pathname.startsWith("/api/coverage") || url.searchParams.has("amount") || url.searchParams.get("mode")?.toLowerCase() === "debug";
      if (expensive && !limiter.take(`e:${ip}`, RATE_LIMITS.expensive)) throw new ApiError(429, "RATE_LIMITED", "too many expensive requests");
      const r = await route(req, url);
      template = r.template;
      status = r.status ?? 200;
      sendJson(res, status, r.body as Wire<unknown>, r.cache, req.method === "HEAD");
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      status = err?.status ?? 500;
      if (!err) log({ level: "error", route: template, error: (e as Error)?.message?.split("\n")[0]?.replace(/0x[0-9a-fA-F]{40}/g, "0x…") ?? "error" });
      if (status === 429) res.setHeader("Retry-After", "30");
      sendJson(res, status, { error: { code: err?.code ?? "INTERNAL", message: err?.message ?? "internal error" } }, "no-store", req.method === "HEAD");
    } finally {
      log({ level: "info", method: req.method, route: template, status, ms: Math.round(performance.now() - t0) });
    }
  };
}
