/** Price history (Chainlink rounds) and the logo proxy's safety rules. */
import { describe, expect, it } from "vitest";
import type { AssetRegistry } from "@skein/robinhood/registry/registry";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogoStore, logoUrls, PLACEHOLDERS, sniffImage } from "../src/logos.js";
import { intelligenceStack } from "@skein/testkit/intelligence";
import { NVDA } from "@skein/testkit/world";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const A = "0x00000000000000000000000000000000000000a1" as const;

function registry(logoUrl: string | null, canonical = true, isin: string | null = null): () => Promise<AssetRegistry> {
  return async () => ({ get: () => ({ canonical, stockMetadata: logoUrl || isin ? { logoUrl, isin } : undefined }) }) as unknown as AssetRegistry;
}
const fetchReturning = (b: Buffer, calls: string[] = []) => (async (u: string) => (calls.push(String(u)), new Response(new Uint8Array(b), { status: 200, headers: { "content-type": "image/png" } }))) as unknown as typeof fetch;
/** Responds per URL; unknown URLs are 404. */
const fetchMap = (m: Record<string, Buffer>, calls: string[] = []) =>
  (async (u: string) => (calls.push(String(u)), m[String(u)] ? new Response(new Uint8Array(m[String(u)]!), { status: 200 }) : new Response(null, { status: 404 }))) as unknown as typeof fetch;
const PARQET = "https://assets.parqet.com/logos/isin/US67066G1040?format=png&size=128";
const RH = "https://cdn.robinhood.com/ncw_assets/logos/x.png";

describe("logo proxy", () => {
  it("sniffs PNG/JPEG/WebP by magic number and rejects SVG", () => {
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(SVG)).toBeNull();
  });

  it("serves a canonical asset's logo from the allowlisted host only", async () => {
    const calls: string[] = [];
    const ok = await new LogoStore(registry("https://cdn.robinhood.com/ncw_assets/logos/x.png"), { fetch: fetchReturning(PNG, calls) }).get(4663, A);
    expect(ok?.contentType).toBe("image/png");
    expect(calls).toEqual(["https://cdn.robinhood.com/ncw_assets/logos/x.png"]);
    for (const bad of ["https://evil.example/x.png", "http://cdn.robinhood.com/x.png", "https://cdn.robinhood.com.evil.io/x.png", "https://u:p@cdn.robinhood.com/x.png"]) {
      const c: string[] = [];
      expect(await new LogoStore(registry(bad), { fetch: fetchReturning(PNG, c) }).get(4663, A)).toBeNull();
      expect(c).toEqual([]); // never fetched
    }
    expect(await new LogoStore(registry("https://cdn.robinhood.com/x.png", false), { fetch: fetchReturning(PNG) }).get(4663, A)).toBeNull();
  });

  it("rejects SVG or oversized bodies even from the allowlisted host", async () => {
    expect(await new LogoStore(registry("https://cdn.robinhood.com/x.png"), { fetch: fetchReturning(SVG) }).get(4663, A)).toBeNull();
    expect(await new LogoStore(registry("https://cdn.robinhood.com/x.png"), { fetch: fetchReturning(Buffer.concat([PNG, Buffer.alloc(300_000)])) }).get(4663, A)).toBeNull();
  });

  it("prefers the ISIN-keyed company logo; the registry URL is the fallback", async () => {
    const OTHER = Buffer.concat([PNG, Buffer.from([1])]);
    const calls: string[] = [];
    const logo = await new LogoStore(registry(RH, true, "US67066G1040"), { fetch: fetchMap({ [PARQET]: OTHER, [RH]: PNG }, calls) }).get(4663, A);
    expect(logo?.bytes.equals(OTHER)).toBe(true);
    expect(calls).toEqual([PARQET]);
    const fallback: string[] = [];
    expect((await new LogoStore(registry(RH, true, "US67066G1040"), { fetch: fetchMap({ [RH]: PNG }, fallback) }).get(4663, A))?.bytes.equals(PNG)).toBe(true);
    expect(fallback).toEqual([PARQET, RH]);
    // malformed ISINs never become URLs
    expect(logoUrls({ stockMetadata: { isin: "US67066G1040/../x", logoUrl: null } as never })).toEqual([]);
  });

  it("rejects the generic placeholder image by hash, from the network and from the disk cache", async () => {
    const placeholder = Buffer.concat([PNG, Buffer.from("placeholder")]);
    PLACEHOLDERS.add(createHash("sha256").update(placeholder).digest("hex"));
    expect(await new LogoStore(registry(RH), { fetch: fetchReturning(placeholder) }).get(4663, A)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "logos-"));
    writeFileSync(join(dir, `${A}.img`), placeholder);
    const calls: string[] = [];
    const logo = await new LogoStore(registry(null, true, "US67066G1040"), { dir, fetch: fetchMap({ [PARQET]: PNG }, calls) }).get(4663, A);
    expect(logo?.bytes.equals(PNG)).toBe(true);
    expect(calls).toEqual([PARQET]); // stale cached placeholder replaced
  });

  it("serves a bundled logo without any network call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bundled-"));
    writeFileSync(join(dir, `${A}.png`), PNG);
    const calls: string[] = [];
    expect((await new LogoStore(registry(null), { bundledDir: dir, fetch: fetchMap({}, calls) }).get(4663, A))?.contentType).toBe("image/png");
    expect(calls).toEqual([]);
  });
});

describe("price history", () => {
  it("reads the last Chainlink rounds, oldest first, with an exact change", async () => {
    const { service } = await intelligenceStack();
    const h = (await service.getPriceHistory(NVDA))!;
    expect(h.source?.provider).toBe("Chainlink");
    expect(h.points.length).toBe(49); // latest + 48 earlier rounds
    expect(h.points.map((p) => p.t)).toEqual([...h.points.map((p) => p.t)].sort());
    expect(Number(h.change!.pct)).toBeGreaterThan(0);
    expect(h.points.at(-1)!.usd).toBe("224.41382169");
  });

  it("is null for unknown or non-canonical assets", async () => {
    const { service } = await intelligenceStack();
    expect(await service.getPriceHistory("0x000000000000000000000000000000000000dead")).toBeNull();
  });
});
