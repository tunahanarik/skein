/**
 * Read-only web server: the JSON API (src/server/api.ts) plus the built web app (web/dist).
 *
 *   pnpm serve            # PORT (default 8787), HOST (default 127.0.0.1)
 *
 * Server mode serves an expired engine snapshot for up to SNAPSHOT_MAX_STALE_MS (default 60 s)
 * while it refreshes in the background, and warms the snapshot at start. While people are using
 * the app (an API request in the last ACTIVE_WINDOW_MS), the snapshot is also refreshed every
 * REFRESH_EVERY_MS so nobody hits the ≈ 8 s cold path; an idle server makes no RPC calls.
 */
import { createServer } from "node:http";
import { AssetIntelligenceService } from "../product/service.js";
import { createRuntime } from "../runtime.js";
import { createApi } from "./api.js";
import { sendJson } from "./json.js";
import { createStatic } from "./static.js";

const env = process.env;
const rt = createRuntime(env);
const intelligence = new AssetIntelligenceService({
  engine: rt.opportunities,
  getPortfolio: (w) => rt.getPortfolio(w),
  maxStaleMs: Number(env.SNAPSHOT_MAX_STALE_MS ?? 60_000),
});
const api = createApi({ intelligence, getRegistry: rt.getRegistry, health: () => rt.reader.health(), chainId: rt.reader.chainId, trustProxy: env.TRUST_PROXY === "1" });
const serveStatic = createStatic(env.WEB_DIST ?? "web/dist");

const REFRESH_EVERY_MS = 45_000;
const ACTIVE_WINDOW_MS = 10 * 60_000;
let lastApiRequest = 0;
setInterval(() => {
  if (Date.now() - lastApiRequest < ACTIVE_WINDOW_MS) intelligence.warm().catch(() => undefined);
}, REFRESH_EVERY_MS).unref();

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  if (path.startsWith("/api/")) {
    lastApiRequest = Date.now();
    return void api(req, res);
  }
  if ((req.method === "GET" || req.method === "HEAD") && serveStatic(req, res)) return;
  sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } }, "no-store");
});
server.headersTimeout = 20_000;
server.requestTimeout = 60_000;

const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? "127.0.0.1";
await rt.reader.assertChainId();
server.listen(port, host, () => console.log(JSON.stringify({ level: "info", msg: "listening", url: `http://${host}:${port}`, rpc: rt.reader.health().endpoint })));
intelligence.warm().then(
  () => console.log(JSON.stringify({ level: "info", msg: "snapshot warm" })),
  (e) => console.log(JSON.stringify({ level: "error", msg: "warm failed", error: (e as Error).message.split("\n")[0] })),
);
