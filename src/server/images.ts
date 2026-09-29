/**
 * Token and network logos for the bridge (LI.FI token lists name them by URL). The browser may
 * not load third-party images (CSP img-src 'self'), so this server fetches them — only from
 * IMAGE_HOSTS, https, no redirects, at most MAX_BYTES, raster images sniffed by magic number or
 * SVG — and serves them from our origin. SVG is served with a sandboxing CSP so it can never run
 * script, even when opened directly. No user data is involved: the URL comes from a public list.
 * Cached in memory (bounded) and on disk (.cache/img); failures are remembered for 10 minutes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sniffImage } from "./logos.js";

/** host → allowed path prefixes ("/" = any). */
export const IMAGE_HOSTS: Readonly<Record<string, readonly string[]>> = {
  "raw.githubusercontent.com": ["/lifinance/", "/trustwallet/assets/"],
  "static.debank.com": ["/"],
  "assets.coingecko.com": ["/"],
  "coin-images.coingecko.com": ["/"],
  "s2.coinmarketcap.com": ["/"],
};
const MAX_BYTES = 256 * 1024;
const MAX_MEM = 3000;
const TYPES: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml" };

export interface Img {
  bytes: Buffer;
  contentType: string;
}

/** The URL if it may be fetched, else null. */
export function allowedImageUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || raw.length > 600) return null;
  const prefixes = IMAGE_HOSTS[u.hostname];
  return prefixes && prefixes.some((p) => u.pathname.startsWith(p)) ? u : null;
}

export function sniffAny(b: Buffer): keyof typeof TYPES | null {
  const r = sniffImage(b);
  if (r) return r;
  if (b.length > 6 && b.toString("latin1", 0, 6) === "GIF89a") return "gif";
  const head = b.toString("utf8", 0, Math.min(b.length, 1024)).replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return "svg";
  return null;
}

export class ImageProxy {
  private readonly mem = new Map<string, Img | { failedAt: number }>();

  constructor(private readonly opts: { dir?: string; fetch?: typeof fetch; now?: () => number } = {}) {}

  async get(raw: string): Promise<Img | null> {
    const u = allowedImageUrl(raw);
    if (!u) return null;
    const key = createHash("sha256").update(u.toString()).digest("hex");
    const now = (this.opts.now ?? Date.now)();
    const hit = this.mem.get(key);
    if (hit && "bytes" in hit) return hit;
    if (hit && now - hit.failedAt < 10 * 60_000) return null;

    const file = this.opts.dir ? join(this.opts.dir, `${key}.img`) : null;
    if (file && existsSync(file)) {
      const b = readFileSync(file);
      const kind = sniffAny(b);
      if (kind) return this.keep(key, { bytes: b, contentType: TYPES[kind]! });
    }
    try {
      const res = await (this.opts.fetch ?? fetch)(u.toString(), { redirect: "error", signal: AbortSignal.timeout(8_000), headers: { Accept: "image/*" } });
      if (!res.ok) return this.fail(key, now);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) return this.fail(key, now);
      const kind = sniffAny(buf);
      if (!kind) return this.fail(key, now);
      if (file) {
        mkdirSync(this.opts.dir!, { recursive: true });
        writeFileSync(file, buf);
      }
      return this.keep(key, { bytes: buf, contentType: TYPES[kind]! });
    } catch {
      return this.fail(key, now);
    }
  }

  private keep(key: string, v: Img): Img {
    if (this.mem.size >= MAX_MEM) this.mem.delete(this.mem.keys().next().value!);
    this.mem.set(key, v);
    return v;
  }

  private fail(key: string, now: number): null {
    if (this.mem.size >= MAX_MEM) this.mem.delete(this.mem.keys().next().value!);
    this.mem.set(key, { failedAt: now });
    return null;
  }
}
