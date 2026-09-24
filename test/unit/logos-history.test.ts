/** Price history (Chainlink rounds) and the logo proxy's safety rules. */
import { describe, expect, it } from "vitest";
import type { AssetRegistry } from "../../src/registry/registry.js";
import { LogoStore, sniffImage } from "../../src/server/logos.js";
import { intelligenceStack } from "../fixtures/intelligence.js";
import { NVDA } from "../fixtures/world.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const A = "0x00000000000000000000000000000000000000a1" as const;

function registry(logoUrl: string | null, canonical = true): () => Promise<AssetRegistry> {
  return async () => ({ get: () => ({ canonical, stockMetadata: logoUrl ? { logoUrl } : undefined }) }) as unknown as AssetRegistry;
}
const fetchReturning = (b: Buffer, calls: string[] = []) => (async (u: string) => (calls.push(String(u)), new Response(new Uint8Array(b), { status: 200, headers: { "content-type": "image/png" } }))) as unknown as typeof fetch;

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
