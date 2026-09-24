/**
 * Token logos, served from our own origin so the browser never contacts a third party (CSP
 * img-src 'self'). Only canonical registry assets, only the registry's own logoUrl, only from
 * LOGO_HOSTS over https, only PNG/JPEG/WebP (no SVG: it can carry script), at most MAX_BYTES.
 * Cached in memory and on disk (.cache/logos, gitignored); a failed fetch is remembered briefly.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AssetRegistry } from "../registry/registry.js";

/** Host of every logoUrl in the Robinhood Stock Token registry (data/registry, 2026-09-24). */
export const LOGO_HOSTS = ["cdn.robinhood.com"] as const;
const MAX_BYTES = 256 * 1024;
const TYPES: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };

export interface Logo {
  bytes: Buffer;
  contentType: string;
}

/** Magic-number sniffing: the declared content type is not trusted. */
export function sniffImage(b: Buffer): keyof typeof TYPES | null {
  if (b.length > 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}

export class LogoStore {
  private readonly mem = new Map<string, Logo | { failedAt: number }>();

  constructor(
    private readonly getRegistry: () => Promise<AssetRegistry>,
    private readonly opts: { dir?: string; fetch?: typeof fetch; now?: () => number } = {},
  ) {}

  /** `address` must be a canonical asset; returns null when there is no acceptable logo. */
  async get(chainId: number, address: `0x${string}`): Promise<Logo | null> {
    const key = address.toLowerCase();
    const now = (this.opts.now ?? Date.now)();
    const hit = this.mem.get(key);
    if (hit && "bytes" in hit) return hit;
    if (hit && now - hit.failedAt < 10 * 60_000) return null;

    const reg = await this.getRegistry();
    const asset = reg.get(chainId, key as `0x${string}`);
    const url = asset?.canonical ? asset.stockMetadata?.logoUrl : null;
    if (!url) return this.fail(key, now);
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return this.fail(key, now);
    }
    if (u.protocol !== "https:" || !LOGO_HOSTS.includes(u.hostname as (typeof LOGO_HOSTS)[number]) || u.username || u.port) return this.fail(key, now);

    const file = this.opts.dir ? join(this.opts.dir, `${key}.img`) : null;
    if (file && existsSync(file)) {
      const b = readFileSync(file);
      const kind = sniffImage(b);
      if (kind) return this.keep(key, { bytes: b, contentType: TYPES[kind]! });
    }
    try {
      const res = await (this.opts.fetch ?? fetch)(u.toString(), { redirect: "error", signal: AbortSignal.timeout(8_000), headers: { Accept: "image/png,image/jpeg,image/webp" } });
      if (!res.ok) return this.fail(key, now);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) return this.fail(key, now);
      const kind = sniffImage(buf);
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

  private keep(key: string, l: Logo): Logo {
    this.mem.set(key, l);
    return l;
  }

  private fail(key: string, now: number): null {
    this.mem.set(key, { failedAt: now });
    return null;
  }
}
