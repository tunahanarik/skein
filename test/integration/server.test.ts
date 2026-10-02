/** HTTP API over the fixture world — offline, real node:http server on an ephemeral port. */
import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApi, RATE_LIMITS } from "@skein/server/api";
import { createStatic, CSP } from "@skein/server/static";
import { intelligenceStack } from "@skein/testkit/intelligence";
import { NOW, NVDA, USDG, WALLET } from "@skein/testkit/world";

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(opts: { staticDir?: string; clock?: { t: number } } = {}) {
  const st = await intelligenceStack(opts.clock ? { clock: opts.clock } : {});
  const logs: Record<string, unknown>[] = [];
  const api = createApi({
    intelligence: st.service,
    getRegistry: async () => st.s.registry,
    health: () => st.s.reader.health(),
    chainId: 4663,
    log: (l) => logs.push(l),
    now: () => opts.clock?.t ?? NOW.getTime(),
  });
  const serveStatic = opts.staticDir ? createStatic(opts.staticDir) : null;
  server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/")) return void api(req, res);
    if (serveStatic?.(req, res)) return;
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const port = (server!.address() as { port: number }).port;
  const get = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${p}`, init);
  return { get, logs, st };
}

describe("HTTP API", () => {
  it("asset by symbol, address or key; bigints as strings; security headers", async () => {
    const { get } = await start();
    for (const ref of ["NVDA", NVDA, `4663:${NVDA.toLowerCase()}`]) {
      const r = await get(`/api/assets/${encodeURIComponent(ref)}`);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body.asset.symbol).toBe("NVDA");
      expect(typeof body.blockNumber).toBe("string");
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("cache-control")).toMatch(/max-age/);
    }
  });

  it("explicit amount quotes, not cached; validation errors are 4xx with codes", async () => {
    const { get } = await start();
    const r = await get(`/api/assets/NVDA?to=USDG&amount=1`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    const trade = body.categories.find((c: { category: string }) => c.category === "TRADE").subcategories[0];
    expect(trade.comparator).toBe("TRADE_QUOTE_V1");
    expect(trade.cards[0].trade.quote.guarantee).toBe("NONE");
    const cases: [string, number, string][] = [
      ["/api/assets/NVDA?amount=1", 400, "AMOUNT_NEEDS_TARGET"],
      ["/api/assets/NVDA?to=USDG&amount=-1", 400, "BAD_AMOUNT"],
      ["/api/assets/NVDA?to=USDG&amount=0", 400, "BAD_AMOUNT"],
      ["/api/assets/NVDA?to=USDG&amount=1e5", 400, "BAD_AMOUNT"],
      ["/api/assets/NVDA?to=NVDA", 400, "SAME_ASSET"],
      ["/api/assets/NVDA?mode=raw", 400, "BAD_MODE"],
      ["/api/assets/NOPE", 404, "UNKNOWN_ASSET"],
      ["/api/assets/0x1234", 400, "BAD_ADDRESS"],
      ["/api/assets/%3Cscript%3E", 400, "BAD_ASSET"],
      ["/api/portfolio/not-an-address", 400, "BAD_ADDRESS"],
      ["/api/nope", 404, "NOT_FOUND"],
    ];
    for (const [p, status, code] of cases) {
      const e = await get(p);
      expect([p, e.status]).toEqual([p, status]);
      const b = await e.json();
      expect(b.error.code).toBe(code);
      expect(JSON.stringify(b)).not.toMatch(/at \w+ \(|node_modules/); // no stack traces
    }
  });

  it("read-only: only GET/HEAD", async () => {
    const { get } = await start();
    const r = await get("/api/assets/NVDA", { method: "POST", body: "{}" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
  });

  it("portfolio: no-store, and the wallet address never appears in logs", async () => {
    const { get, logs } = await start();
    const r = await get(`/api/portfolio/${WALLET}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = await r.json();
    expect(b.assets.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain(WALLET.slice(2, 14).toLowerCase());
    expect(JSON.stringify(logs).toLowerCase()).not.toContain(WALLET.slice(2, 14).toLowerCase());
    expect(logs.some((l) => l.route === "/api/portfolio/:address")).toBe(true);
  });

  it("asset list, coverage and health", async () => {
    const { get } = await start();
    const a = await (await get("/api/assets")).json();
    expect(a.assets.map((x: { symbol: string }) => x.symbol)).toEqual(expect.arrayContaining(["NVDA", "USDG", "WETH"]));
    const c = await (await get("/api/coverage")).json();
    expect(c.rows.length).toBe(a.assets.length);
    const h = await (await get("/api/health")).json();
    expect(h).toMatchObject({ chainId: 4663, readOnly: true });
  });

  it("rate limits expensive requests per client (429 + Retry-After)", async () => {
    const { get } = await start();
    const statuses: number[] = [];
    for (let i = 0; i < RATE_LIMITS.expensive + 2; i++) statuses.push((await get(`/api/assets/NVDA?mode=debug`)).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(RATE_LIMITS.expensive);
    const last = await get(`/api/assets/NVDA?mode=debug`);
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBe("30");
    expect((await get(`/api/assets/${USDG}`)).status).toBe(200); // cheap requests still pass
  });
});

describe("static web app", () => {
  it("serves the shell with a strict CSP, falls back for routes, blocks traversal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "web-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>x</title>");
    writeFileSync(join(dir, "assets", "app-abc.js"), "console.log(1)");
    const { get } = await start({ staticDir: dir });
    const shell = await get("/asset/NVDA");
    expect(shell.status).toBe(200);
    expect(shell.headers.get("content-security-policy")).toBe(CSP);
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("connect-src 'self';");
    const js = await get("/assets/app-abc.js");
    expect(js.headers.get("cache-control")).toMatch(/immutable/);
    expect((await get("/assets/missing.js")).status).toBe(404);
    expect((await get("/..%2f..%2fpackage.json")).status).toBe(404);
  });
});

describe("asset shell meta", () => {
  it("escapes values and replaces the generic title", async () => {
    const { shellWithMeta } = await import("@skein/server/static");
    const html = shellWithMeta('<html><head><title>Skein</title><meta name="description" content="x" /></head><body></body></html>', { title: 'A<b>"', description: "d & e" });
    expect(html).toContain("<title>A&lt;b&gt;&quot;</title>");
    expect(html).toContain('property="og:description" content="d &amp; e"');
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html.match(/name="description"/g)).toHaveLength(1);
  });
});
