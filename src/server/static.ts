/**
 * Serves the built web app (web/dist) with a strict CSP. Unknown non-file paths fall back to
 * index.html (client-side routing). Path traversal is impossible: the resolved path must stay
 * inside the root.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { SECURITY_HEADERS } from "./json.js";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

/** No inline scripts, no third-party origins: the page talks only to its own API. */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function createStatic(rootDir: string) {
  const root = resolve(rootDir);
  return function serve(req: IncomingMessage, res: ServerResponse): boolean {
    if (!existsSync(root)) return false;
    const url = new URL(req.url ?? "/", "http://localhost");
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    let file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return false;
    const isFile = existsSync(file) && statSync(file).isFile();
    if (!isFile) {
      if (extname(rel)) return false; // a missing asset is a 404, not the app shell
      file = join(root, "index.html");
      if (!existsSync(file)) return false;
    }
    const ext = extname(file);
    res.statusCode = 200;
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("Content-Type", TYPES[ext] ?? "application/octet-stream");
    // Hashed build assets are immutable; the shell is revalidated.
    res.setHeader("Cache-Control", file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  };
}
