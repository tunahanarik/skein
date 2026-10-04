/**
 * Static export for viewing Skein where the server is not reachable (a claude.ai artifact). Data
 * is captured once at build time from a running server; the output is one self-contained HTML
 * fragment (scripts, styles, fonts and images inlined; no doctype/html/head/body, the host adds them).
 *
 *   pnpm serve                              (another terminal)
 *   pnpm web:snapshot                       the whole site → dist/site.html
 *
 * The real app runs unchanged; API requests, the live stream and token logos are answered from the
 * capture (site-shims.ts, site-api.ts) and pages change through an in-memory router (site-router.ts).
 */
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { makeKeyOf } from "./keys";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const slash = (p: string) => p.replace(/\\/g, "/").toLowerCase();
const SERVER = (process.env.SKEIN_URL ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
const RANGES = ["1D", "1W", "1M", "1Y"] as const;
/** Assets with full detail (Terminal and Compare defaults), plus the deepest pools. */
const DETAILED = ["NVDA", "TSLA", "SPY", "USDG", "WETH", "AAPL"];
const DEEPEST = 14;
/** The trade quote the asset page asks for by default (1 unit into USDG). */
const QUOTED = ["NVDA", "TSLA", "SPY", "WETH"];
const SITE = "virtual:skein-site";

type Row = { symbol: string; liquidityUsd?: number | null };
type Health = { chainId: number; readOnly: boolean; rpc: { status: string; latestBlock: string | null } };
type Listed = { key: string; symbol: string; address: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET from the server, waiting out its rate limit (429) a few times before giving up. */
async function request(url: string, timeoutMs = 180_000): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (r.status !== 429 || attempt === 6) return r;
    await r.arrayBuffer();
    await sleep(Math.max(1000, Number(r.headers.get("retry-after") ?? 0) * 1000));
  }
}

async function getJson<T>(path: string): Promise<T> {
  const r = await request(SERVER + path).catch((e: Error) => {
    throw new Error(`snapshot: ${SERVER} is not reachable (${e.message}). Start the server first: pnpm serve`);
  });
  if (!r.ok) throw new Error(`snapshot: GET ${path} returned ${r.status}`);
  return (await r.json()) as T;
}

/** Like getJson, but a failed request is skipped (the page then shows its own "no data" state). */
async function tryJson(path: string): Promise<unknown> {
  const r = await request(SERVER + path).catch(() => null);
  return r?.ok ? r.json() : undefined;
}

async function logoDataUri(address: string): Promise<string | null> {
  const r = await request(`${SERVER}/api/logo/${address}`, 30_000).catch(() => null);
  const type = (r?.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!r?.ok || !/^image\/(png|jpeg|webp|gif|svg\+xml)$/.test(type)) return null;
  return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
}

/** Runs jobs a few at a time, so the server is not flooded. */
async function runAll(jobs: (() => Promise<unknown>)[], width = 6): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: width }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }),
  );
}

/**
 * The live stream's current pairs and prices for these assets. The server may send a snapshot or
 * one event per pool, so the stream is read until it goes quiet for a moment (or 20 s pass).
 */
async function streamState(keys: string[]): Promise<{ pairs: unknown[]; prices: unknown[]; pollMs: number }> {
  const pairs = new Map<string, unknown>();
  const prices = new Map<string, unknown>();
  let pollMs = 2000;
  for (let i = 0; i < keys.length; i += 12) {
    const chunk = keys.slice(i, i + 12).join(",");
    const ac = new AbortController();
    const stop = setTimeout(() => ac.abort(), 20_000);
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(quiet);
      quiet = setTimeout(() => ac.abort(), 2500);
    };
    try {
      const r = await fetch(`${SERVER}/api/stream?${new URLSearchParams({ pairs: chunk, prices: chunk })}`, { signal: ac.signal });
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (let cut = buf.indexOf("\n\n"); cut >= 0; cut = buf.indexOf("\n\n")) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const event = /^event: (\w+)$/m.exec(block)?.[1];
          const raw = /^data: (.*)$/m.exec(block)?.[1];
          if (!event || !raw) continue;
          const d = JSON.parse(raw) as { id?: string; key?: string; pollMs?: number; pairs?: { id: string }[]; prices?: { key: string }[] };
          if (event === "snapshot") {
            pollMs = d.pollMs ?? pollMs;
            d.pairs?.forEach((p) => pairs.set(p.id, p));
            d.prices?.forEach((p) => prices.set(p.key, p));
            if (d.pairs?.length || d.prices?.length) settle();
          } else if (event === "pair" && d.id) (pairs.set(d.id, d), settle());
          else if (event === "price" && d.key) (prices.set(d.key, d), settle());
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") throw e;
    } finally {
      clearTimeout(stop);
      clearTimeout(quiet);
      ac.abort();
    }
  }
  return { pairs: [...pairs.values()], prices: [...prices.values()], pollMs };
}

/* ---------------- site ---------------- */

/** Points every import of src/router.ts and src/api.ts at the snapshot stand-ins. */
function siteStubs(): Plugin {
  const swaps: [RegExp, string][] = [
    [/\/src\/router\.ts$/, here("./site-router.ts")],
    [/\/src\/api\.ts$/, here("./site-api.ts")],
  ];
  return {
    name: "skein-snapshot-site-stubs",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !source.startsWith(".")) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!r) return null;
      for (const [re, to] of swaps) if (re.test(slash(r.id)) && slash(importer) !== slash(to)) return to;
      return null;
    },
  };
}

/** `virtual:skein-site`: every response the site needs for the captured assets, keyed by keys.ts. */
function siteData(): Plugin {
  return {
    name: "skein-snapshot-site-data",
    resolveId: (id) => (id === SITE ? `\0${SITE}` : null),
    async load(id) {
      if (id !== `\0${SITE}`) return null;
      const [list, markets, coverage, health] = await Promise.all([getJson<{ assets: Listed[] }>("/api/assets"), getJson<{ rows: Row[] }>("/api/markets"), getJson("/api/coverage"), getJson<Health>("/api/health")]);
      const keyOf = makeKeyOf(list.assets);
      const unique = (s: string) => list.assets.filter((a) => a.symbol === s).length === 1;
      const bySymbol = new Map(list.assets.map((a) => [a.symbol, a]));
      const get: Record<string, unknown> = {};
      const record = async (path: string, required = false) => {
        const body = required ? await getJson(path) : await tryJson(path);
        const u = new URL(path, SERVER);
        if (body !== undefined) get[keyOf(u.pathname, u.search)] = body;
      };
      get["/api/assets"] = list;
      get["/api/markets"] = markets;
      get["/api/coverage"] = coverage;
      // Only the health fields the pages read: the RPC endpoint and last error stay out.
      get["/api/health"] = { chainId: health.chainId, readOnly: health.readOnly, rpc: { status: health.rpc.status, latestBlock: health.rpc.latestBlock } };

      const deepest = [...markets.rows].sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0)).slice(0, DEEPEST).map((r) => r.symbol);
      const detailed = [...new Set([...DETAILED, ...deepest])].filter((s) => bySymbol.has(s) && unique(s));
      const jobs: (() => Promise<unknown>)[] = [];
      for (const s of detailed) {
        const a = bySymbol.get(s)!;
        jobs.push(() => record(`/api/assets/${a.address}`, true));
        for (const r of RANGES) jobs.push(() => record(`/api/assets/${a.address}/chart?range=${r}`));
      }
      jobs.push(() => record(`/api/assets/${bySymbol.get("NVDA")!.address}?mode=debug`));
      for (const s of QUOTED) if (bySymbol.has(s)) jobs.push(() => record(`/api/assets/${bySymbol.get(s)!.address}?to=USDG&amount=1`));
      // Day lines for every other row of the markets table.
      for (const a of list.assets) if (!detailed.includes(a.symbol)) jobs.push(() => record(`/api/assets/${a.address}/chart?range=1D`));
      await runAll(jobs);

      // The sample wallet is the deepest NVDA pool: a contract, never a person.
      type Intel = { categories: { category: string; subcategories: { cards: { trade?: { route: { markets: { marketId: string }[] } } }[] }[] }[] };
      const nvda = get[keyOf(`/api/assets/${bySymbol.get("NVDA")!.address}`)] as Intel | undefined;
      const pool = nvda?.categories.find((c) => c.category === "TRADE")?.subcategories[0]?.cards[0]?.trade?.route.markets[0]?.marketId.split(":").at(-1);
      // The wallet page asks for holdings (positions=0) and for positions side by side.
      if (pool) await runAll([() => record(`/api/portfolio/${pool}?positions=0`), () => record(`/api/portfolio/${pool}/positions`)]);

      const logos: Record<string, string> = {};
      await runAll(
        list.assets.map((a) => async () => {
          const uri = await logoDataUri(a.address.toLowerCase());
          if (uri) logos[a.address.toLowerCase()] = uri;
        }),
        8,
      );
      const stream = await streamState(detailed.map((s) => bySymbol.get(s)!.key));
      const data = { capturedAt: new Date().toISOString(), block: health.rpc.latestBlock, detailed, sampleWallet: pool ?? null, get, logos, stream };
      const out = `export default ${JSON.stringify(data)};`;
      this.info(`captured ${Object.keys(get).length} responses, ${Object.keys(logos).length} logos, ${stream.pairs.length} live pairs; detail for ${detailed.join(" ")}; sample wallet ${pool ?? "none"}; ${(out.length / 1e6).toFixed(1)} MB`);
      return out;
    },
  };
}

/** Bundled images under public/ (protocol, wallet and token marks) become data: URIs. */
function inlinePublic(): Plugin {
  const mime: Record<string, string> = { webp: "image/webp", png: "image/png", svg: "image/svg+xml" };
  return {
    name: "skein-snapshot-public",
    transform(code, id) {
      if (!/[\\/]src[\\/].*\.tsx?$/.test(id.split("?")[0]!) || !/"\/(protocols|wallets|tokens)\//.test(code)) return null;
      return code.replace(/"\/(protocols|wallets|tokens)\/([\w.-]+)\.(webp|png|svg)"/g, (_m, dir: string, name: string, ext: string) =>
        JSON.stringify(`data:${mime[ext]};base64,${readFileSync(here(`../public/${dir}/${name}.${ext}`)).toString("base64")}`),
      );
    },
  };
}

/* ---------------- output ---------------- */

/** Inlines the single JS chunk and the CSS into the HTML and drops the document wrapper. */
function singleFile(html: string): Plugin {
  return {
    name: "skein-snapshot-single-file",
    enforce: "post",
    generateBundle(_options, bundle) {
      const page = bundle[html];
      if (!page || page.type !== "asset") throw new Error(`snapshot: ${html} is missing from the bundle`);
      const files = Object.values(bundle);
      const js = files.flatMap((f) => (f.type === "chunk" ? [f] : []));
      const css = files.flatMap((f) => (f.type === "asset" && f.fileName.endsWith(".css") ? [f] : []));
      if (js.length !== 1) throw new Error(`snapshot: expected one JS chunk, got ${js.length}`);
      const title = /<title>[\s\S]*?<\/title>/.exec(String(page.source))?.[0] ?? "";
      const styles = css.map((f) => `<style>\n${String(f.source)}\n</style>`).join("\n");
      const code = js[0]!.code.replace(/<\/script/gi, "<\\/script");
      page.source = `${title}\n${styles}\n<div id="root"></div>\n<script type="module">\n${code}\n</script>\n`;
      for (const f of [...js, ...css]) delete bundle[f.fileName];
    },
  };
}

export default defineConfig({
  root: here("."),
  base: "./",
  publicDir: false,
  plugins: [siteStubs(), siteData(), inlinePublic(), react(), singleFile("site.html")],
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    target: "es2022",
    modulePreload: false,
    assetsInlineLimit: () => true,
    rolldownOptions: { input: here("./site.html"), output: { codeSplitting: false } },
  },
});
