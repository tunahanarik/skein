// Static file server for the repo root on localhost (a secure context, so WebCodecs is available).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
const ROOT = resolve("../..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".json": "application/json" };
export function serve(port = 8799) {
  const s = createServer(async (req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)).replace(/^[\/]+/, "");
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try { const b = await readFile(file); res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" }); res.end(b); }
    catch { res.writeHead(404).end(); }
  });
  return new Promise((r) => s.listen(port, "127.0.0.1", () => r(s)));
}
