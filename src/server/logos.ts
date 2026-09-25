/**
 * Token logos, served from our own origin so the browser never contacts a third party (CSP
 * img-src 'self'). Only canonical registry assets, only PNG/JPEG/WebP (no SVG: it can carry
 * script), at most MAX_BYTES. Sources, first acceptable wins:
 *
 *   1. data/logos/<address>.png  bundled, reviewed by hand (core assets: WETH, USDG)
 *   2. Parqet by ISIN            the company's own logo, keyed by the registry's ISIN (an exact
 *                                security identity, unlike a ticker)
 *   3. the registry's logoUrl    Robinhood's CDN; today it returns one generic Robinhood mark for
 *                                every token, which is rejected by hash (PLACEHOLDERS)
 *
 * Cached in memory and on disk (.cache/logos, gitignored); a failed lookup is remembered briefly.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Asset } from "../registry/asset.js";
import type { AssetRegistry } from "../registry/registry.js";

/** Hosts a logo may be fetched from (https only, no credentials, default port, no redirects). */
export const LOGO_HOSTS = ["assets.parqet.com", "cdn.robinhood.com"] as const;
/** sha256 of images that are not a token's own logo (Robinhood's generic mark, 2026-09-25). */
export const PLACEHOLDERS = new Set(["3acff25ee4e8f842d245c315002965c712c7f42f00fff4377e1ad8ce88d78ab1"]);
const MAX_BYTES = 256 * 1024;
const TYPES: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

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

/** An acceptable logo image, or null (wrong format, too big, or a known placeholder). */
export function acceptImage(b: Buffer): Logo | null {
  if (b.length === 0 || b.length > MAX_BYTES) return null;
  const kind = sniffImage(b);
  if (!kind) return null;
  if (PLACEHOLDERS.has(createHash("sha256").update(b).digest("hex"))) return null;
  return { bytes: b, contentType: TYPES[kind]! };
}

/** Remote logo URLs for an asset, in order of preference; only allowlisted https URLs. */
export function logoUrls(asset: Pick<Asset, "stockMetadata" | "underlying">): string[] {
  const out: string[] = [];
  const isin = asset.stockMetadata?.isin ?? asset.underlying?.isin ?? null;
  if (isin && ISIN.test(isin)) out.push(`https://assets.parqet.com/logos/isin/${isin}?format=png&size=128`);
  if (asset.stockMetadata?.logoUrl) out.push(asset.stockMetadata.logoUrl);
  return out.filter((url) => {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && (LOGO_HOSTS as readonly string[]).includes(u.hostname) && !u.username && !u.password && !u.port;
    } catch {
      return false;
    }
  });
}

export class LogoStore {
  private readonly mem = new Map<string, Logo | { failedAt: number }>();

  constructor(
    private readonly getRegistry: () => Promise<AssetRegistry>,
    private readonly opts: { dir?: string; bundledDir?: string; fetch?: typeof fetch; now?: () => number } = {},
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
    if (!asset?.canonical) return this.fail(key, now);

    for (const dir of [this.opts.bundledDir, this.opts.dir]) {
      const file = dir ? join(dir, dir === this.opts.dir ? `${key}.img` : `${key}.png`) : null;
      const logo = file && existsSync(file) ? acceptImage(readFileSync(file)) : null;
      if (logo) return this.keep(key, logo);
    }

    for (const url of logoUrls(asset)) {
      try {
        const res = await (this.opts.fetch ?? fetch)(url, { redirect: "error", signal: AbortSignal.timeout(8_000), headers: { Accept: "image/png,image/jpeg,image/webp" } });
        if (!res.ok) continue;
        const logo = acceptImage(Buffer.from(await res.arrayBuffer()));
        if (!logo) continue;
        if (this.opts.dir) {
          mkdirSync(this.opts.dir, { recursive: true });
          writeFileSync(join(this.opts.dir, `${key}.img`), logo.bytes);
        }
        return this.keep(key, logo);
      } catch {
        /* next source */
      }
    }
    return this.fail(key, now);
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
