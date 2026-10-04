/**
 * Read-only web server: the JSON API (src/api.ts) plus the built web app (apps/web/dist).
 *
 *   pnpm serve            # PORT (default 8787), HOST (default 127.0.0.1)
 *
 * Server mode serves an expired engine snapshot for up to SNAPSHOT_MAX_STALE_MS (default 5 min)
 * while it refreshes in the background, and warms the snapshot at start. While people are using
 * the app (an API request in the last ACTIVE_WINDOW_MS), the snapshot is also refreshed every
 * REFRESH_EVERY_MS so nobody hits the ≈ 8 s cold path; an idle server makes no RPC calls.
 */
import { createServer } from "node:http";
import { AssetIntelligenceService } from "@skein/product/service";
import { createRuntime } from "@skein/runtime/runtime";
import { redactRpcUrl } from "@skein/chain/health";
import { runtimeMode } from "@skein/chain/rpcConfig";
import { createApi } from "./api.js";
import { sendJson } from "./json.js";
import { LogoStore } from "./logos.js";
import { LiveHub } from "./live.js";
import { ChainlinkRounds } from "@skein/product/charts";
import { fetchShareHistory, fetchShareQuotes, type ChartRange } from "@skein/robinhood/sources/rhMarket";
import { RateHistory } from "./rateHistory.js";
import { GeckoTerminalVolumes } from "@skein/robinhood/sources/geckoterminal";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStatic, CSP, isOriginForm, shellWithMeta } from "./static.js";
import { SECURITY_HEADERS } from "./json.js";

const env = process.env;
const rt = createRuntime(env);
const rates = new RateHistory(env.RATE_HISTORY_FILE ?? ".cache/history/rates.jsonl");
const intelligence = new AssetIntelligenceService({
  engine: rt.opportunities,
  getPortfolio: (w) => rt.getPortfolio(w),
  foregroundReader: rt.reader,
  prices: rt.prices,
  chartRounds: new ChainlinkRounds(rt.reader, { dir: ".cache/chainlink" }),
  ...(env.DISABLE_SHARE_HISTORY === "1" ? {} : { shareHistory: (sym: string, range: ChartRange) => fetchShareHistory(sym, range), shareQuotes: (syms: string[]) => fetchShareQuotes(syms) }),
  ...(env.DISABLE_THIRD_PARTY_VOLUME === "1" ? {} : { volumes: new GeckoTerminalVolumes(rt.http) }),
  onSnapshot: (opps, takenAt) => rates.record(opps, takenAt),
  maxStaleMs: Number(env.SNAPSHOT_MAX_STALE_MS ?? 300_000),
});
const live = new LiveHub(rt.reader, { marketsFor: (k, n) => intelligence.liveMarkets(k, n), feedFor: (k) => intelligence.liveFeed(k) });
const api = createApi({ live, intelligence, getRegistry: rt.getRegistry, health: () => rt.reader.health(), chainId: rt.reader.chainId, trustProxy: env.TRUST_PROXY === "1", priority: rt.priority, logos: new LogoStore(rt.getRegistry, { dir: ".cache/logos", bundledDir: fileURLToPath(new URL("../data/logos", import.meta.url)) }), rates });
const webDist = env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const serveStatic = createStatic(webDist);

/** /asset/:ref gets an app shell whose title and preview text name the asset (registry data only). */
async function assetShell(path: string): Promise<string | null> {
  const m = /^\/asset\/([^/]{1,100})$/.exec(path);
  const index = join(webDist, "index.html");
  if (!m || !existsSync(index)) return null;
  let ref: string;
  try {
    ref = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  const reg = await rt.getRegistry();
  const a = /^0x[0-9a-fA-F]{40}$/.test(ref) ? reg.get(rt.reader.chainId, ref.toLowerCase() as `0x${string}`) : reg.canonicalBySymbol(ref).length === 1 ? reg.canonicalBySymbol(ref)[0] : undefined;
  if (!a?.canonical) return null;
  return shellWithMeta(readFileSync(index, "utf8"), {
    title: `${a.symbol} · Skein`,
    description: `What ${a.symbol} (${a.name.slice(0, 60)}) can do on Robinhood Chain: trade, earn, borrow and provide liquidity. Read only; sources and ages for every number.`,
  });
}

const REFRESH_EVERY_MS = 45_000;
const ACTIVE_WINDOW_MS = 30 * 60_000;
// While idle, refresh often enough that the snapshot never ages out of the stale window
// (15 s TTL + SNAPSHOT_MAX_STALE_MS): a visitor after a quiet hour never waits for a cold load.
const IDLE_REFRESH_EVERY_MS = 4 * 60_000;
let lastApiRequest = 0;
let lastWarm = Date.now();
setInterval(() => {
  const now = Date.now();
  if (now - lastApiRequest >= ACTIVE_WINDOW_MS && now - lastWarm < IDLE_REFRESH_EVERY_MS) return;
  lastWarm = now;
  intelligence.warm().catch(() => undefined);
}, REFRESH_EVERY_MS).unref();

const server = createServer((req, res) => {
  // Only origin-form targets ("/path"): "//host:port" or absolute-form targets are refused here,
  // before any URL parsing (a single malformed request once crashed the process; SRV-1).
  if (!isOriginForm(req.url)) return void sendJson(res, 400, { error: { code: "BAD_REQUEST", message: "bad request target" } }, "no-store");
  const path = req.url.split("?")[0] ?? "/";
  if (path.startsWith("/api/")) {
    lastApiRequest = Date.now();
    return void api(req, res);
  }
  if (req.method === "GET" && path.startsWith("/asset/")) {
    void assetShell(path).then(
      (html) => {
        if (html === null) {
          if (!serveStatic(req, res)) sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } }, "no-store");
          return;
        }
        res.statusCode = 200;
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
        res.setHeader("Content-Security-Policy", CSP);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(html);
      },
      () => {
        if (!serveStatic(req, res)) sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } }, "no-store");
      },
    );
    return;
  }
  if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res)) return;
  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } }, "no-store");
});
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;

// A bug must never leave a half-working process: log one line and exit, so the supervisor
// (Docker restart policy, systemd) starts a clean one. No wallet ever reaches these logs.
/** First line of an error, with addresses masked and any URL cut to its origin (keyed RPC URLs). */
const safeError = (e: unknown) =>
  String((e as Error)?.message ?? e)
    .split("\n")[0]!
    .replace(/0x[0-9a-fA-F]{40}/g, "0x…")
    .replace(/https?:\/\/[^\s"'<>]+/g, (u) => redactRpcUrl(u));
const fatal = (kind: string) => (e: unknown) => {
  console.error(JSON.stringify({ level: "fatal", msg: kind, error: safeError(e) }));
  process.exit(1);
};
process.on("uncaughtException", fatal("uncaught exception"));
process.on("unhandledRejection", fatal("unhandled rejection"));

const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? "127.0.0.1";
try {
  await rt.reader.assertChainId();
} catch (e) {
  // viem errors embed the request URL; a keyed RPC URL must never reach the logs (SRV-9).
  console.error(JSON.stringify({ level: "fatal", msg: "RPC check failed", rpc: rt.reader.health().endpoint, error: safeError(e) }));
  process.exit(1);
}
server.listen(port, host, () => console.log(JSON.stringify({ level: "info", msg: "listening", url: `http://${host}:${port}`, mode: runtimeMode(env), rpc: rt.reader.health().endpoint })));
intelligence.warm().then(
  () => console.log(JSON.stringify({ level: "info", msg: "snapshot warm" })),
  (e) => console.log(JSON.stringify({ level: "error", msg: "warm failed", error: safeError(e) })),
);
