/**
 * Read-only HTTP API over the Phase 5 product service (docs/api.md). No framework: node:http.
 *
 *   GET /api/health                                   RPC health (endpoint redacted), chain id
 *   GET /api/assets                                   canonical asset list (search / picker)
 *   GET /api/assets/:ref?mode=&to=&amount=&exec=1     AssetIntelligence (ref = symbol, address or key; exec=1 quotes only executable venues)
 *   GET /api/portfolio/:address?mode=                 PortfolioIntelligence (never cached, never logged)
 *   GET /api/coverage                                 coverage matrix
 *   GET /api/assets/:ref/history                      Chainlink price history (last rounds)
 *   GET /api/assets/:ref/chart?range=1D|1W|1M|1Y      price chart (share data × multiplier, or Chainlink)
 *   GET /api/rates/history?id=<opportunity id>          locally recorded rate history of one opportunity
 *   GET /api/logo/:address                            token logo (canonical assets; proxied, sniffed)
 *   GET /api/markets                                  every canonical asset: price and today's change
 *   GET /api/aggregator                               Stock Token routes via LI.FI (background scan, vs Chainlink)
 *   GET /api/stream?pairs=NVDA&prices=TSLA,WETH        live pair and token prices (Server-Sent Events)
 *   GET /api/img?u=<url>                              bridge token / network logo (allowlisted hosts; proxied, sniffed)
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
import type { LogoStore } from "./logos.js";
import type { ImageProxy } from "./images.js";
import type { LiveHub } from "./live.js";
import type { AggregatorScanner } from "../product/aggregator.js";
import type { RateHistory } from "./rateHistory.js";
import { RateLimiter } from "./rateLimit.js";
import { SECURITY_HEADERS, sendJson } from "./json.js";
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
  logos?: LogoStore;
  images?: ImageProxy;
  live?: LiveHub;
  aggregator?: AggregatorScanner;
  rates?: RateHistory;
}

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

/** Requests per minute per client IP. Expensive = quotes, portfolio, DEBUG, coverage. */
export const RATE_LIMITS = { general: 120, expensive: 20, logos: 1200 } as const;
/** Concurrent live streams: per client IP and in total. */
export const STREAM_LIMITS = { perIp: 4, total: 300 } as const;

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
    if (p === "/api/rates/history") {
      const id = q.get("id") ?? "";
      if (!/^4663:[a-z0-9-]{1,40}:[A-Z_]{2,20}:[a-z0-9_-]{1,40}:[0-9a-zx:]{1,200}$/i.test(id)) throw new ApiError(400, "BAD_ID", "not an opportunity id");
      if (!deps.rates) throw new ApiError(404, "NO_HISTORY", "rate history is not recorded on this server");
      return { template: "/api/rates/history", body: { id, ...deps.rates.get(id) }, cache: "public, max-age=60", expensive: false };
    }
    if (p === "/api/coverage") {
      return { template: "/api/coverage", body: { rows: await deps.intelligence.getCoverage() }, cache: "public, max-age=15", expensive: true };
    }
    if (p === "/api/markets") {
      return { template: "/api/markets", body: { rows: await deps.intelligence.getMarkets() }, cache: "public, max-age=30", expensive: false };
    }
    if (p === "/api/aggregator") {
      if (!deps.aggregator) throw new ApiError(404, "NO_AGGREGATOR", "aggregator coverage is not enabled on this server");
      return { template: "/api/aggregator", body: { lastScanAt: deps.aggregator.lastScanAt, rows: deps.aggregator.all() }, cache: "public, max-age=60", expensive: false };
    }
    const cm = /^\/api\/assets\/([^/]{1,100})\/chart$/.exec(p);
    if (cm) {
      const range = (q.get("range") ?? "1D").toUpperCase();
      if (!["1D", "1W", "1M", "1Y"].includes(range)) throw new ApiError(400, "BAD_RANGE", "range must be 1D, 1W, 1M or 1Y");
      const key = resolveRef(await deps.getRegistry(), decodeURIComponent(cm[1]!), deps.chainId);
      const c = await deps.intelligence.getPriceChart(key, range as "1D");
      if (!c) throw new ApiError(404, "NO_CHART", "no chart for this asset");
      return { template: "/api/assets/:ref/chart", body: c, cache: range === "1D" ? "public, max-age=30" : "public, max-age=120", expensive: false };
    }
    let m = /^\/api\/assets\/([^/]{1,100})\/history$/.exec(p);
    if (m) {
      const reg = await deps.getRegistry();
      const key = resolveRef(reg, decodeURIComponent(m[1]!), deps.chainId);
      const h = await deps.intelligence.getPriceHistory(key);
      if (!h) throw new ApiError(404, "NO_HISTORY", "no price history for this asset");
      return { template: "/api/assets/:ref/history", body: h, cache: "public, max-age=60", expensive: false };
    }
    m = /^\/api\/assets\/([^/]{1,100})$/.exec(p);
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
      const executableOnly = amount !== null && q.get("exec") === "1";
      const v = await deps.intelligence.getAssetIntelligence(key, { mode, ...(tradeTarget ? { tradeTarget } : {}), ...(amount !== null ? { tradeAmount: amount } : {}), ...(executableOnly ? { executableOnly } : {}) });
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

  async function logo(req: IncomingMessage, res: ServerResponse, raw: string): Promise<boolean> {
    if (!deps.logos) return false;
    let addr: string;
    try {
      addr = decodeURIComponent(raw);
    } catch {
      return false;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return false;
    const l = await deps.logos.get(deps.chainId, addr.toLowerCase() as `0x${string}`);
    if (!l) return false;
    res.statusCode = 200;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader("Content-Type", l.contentType);
    res.setHeader("Content-Length", l.bytes.length);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.end(req.method === "HEAD" ? undefined : l.bytes);
    return true;
  }

  async function image(req: IncomingMessage, res: ServerResponse, u: string | null): Promise<boolean> {
    if (!deps.images || !u) return false;
    const img = await deps.images.get(u);
    if (!img) return false;
    res.statusCode = 200;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader("Content-Type", img.contentType);
    res.setHeader("Content-Length", img.bytes.length);
    res.setHeader("Cache-Control", "public, max-age=86400");
    // SVG can carry script: the sandbox keeps it inert even if opened directly.
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.end(req.method === "HEAD" ? undefined : img.bytes);
    return true;
  }

  const streamsByIp = new Map<string, number>();
  let streams = 0;

  /** Server-Sent Events: snapshot on connect, then changes; a comment line every 15 s keeps proxies open. */
  async function stream(req: IncomingMessage, res: ServerResponse, url: URL, ip: string): Promise<void> {
    if (!deps.live) throw new ApiError(404, "NO_STREAM", "live prices are not enabled on this server");
    const reg = await deps.getRegistry();
    const list = (k: string) =>
      [...new Set((url.searchParams.get(k) ?? "").split(",").map((x) => x.trim()).filter(Boolean))].slice(0, 12).map((r) => resolveRef(reg, r, deps.chainId));
    const pairs = list("pairs");
    const prices = list("prices");
    if (!pairs.length && !prices.length) throw new ApiError(400, "NO_ASSETS", "name assets in pairs= and/or prices=");
    if (streams >= STREAM_LIMITS.total || (streamsByIp.get(ip) ?? 0) >= STREAM_LIMITS.perIp) throw new ApiError(429, "TOO_MANY_STREAMS", "too many live streams");
    streams++;
    streamsByIp.set(ip, (streamsByIp.get(ip) ?? 0) + 1);
    res.statusCode = 200;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.write("retry: 5000\n\n");
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const unsubscribe = deps.live.subscribe({ pairs, prices }, send);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    const close = () => {
      clearInterval(ping);
      unsubscribe();
      streams--;
      const n = (streamsByIp.get(ip) ?? 1) - 1;
      if (n > 0) streamsByIp.set(ip, n);
      else streamsByIp.delete(ip);
    };
    req.on("close", close);
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
      // Logos: many per page and cached, so they get their own, larger bucket.
      const lm = /^\/api\/logo\/([^/]{1,100})$/.exec(url.pathname);
      if (lm) {
        template = "/api/logo/:address";
        if (!limiter.take(`l:${ip}`, RATE_LIMITS.logos)) throw new ApiError(429, "RATE_LIMITED", "too many requests");
        if (await logo(req, res, lm[1]!)) return;
        throw new ApiError(404, "NO_LOGO", "no logo");
      }
      if (url.pathname === "/api/stream") {
        template = "/api/stream";
        if (!limiter.take(`g:${ip}`, RATE_LIMITS.general)) throw new ApiError(429, "RATE_LIMITED", "too many requests");
        await stream(req, res, url, ip);
        return;
      }
      if (url.pathname === "/api/img") {
        template = "/api/img";
        if (!limiter.take(`l:${ip}`, RATE_LIMITS.logos)) throw new ApiError(429, "RATE_LIMITED", "too many requests");
        if (await image(req, res, url.searchParams.get("u"))) return;
        throw new ApiError(404, "NO_IMAGE", "no image");
      }
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
