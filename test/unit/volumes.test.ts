/** GeckoTerminal volumes: batching, bounded wait, 429 backoff, cache. */
import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/lib/http.js";
import { GeckoTerminalVolumes } from "../../src/sources/geckoterminal.js";

const P = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const body = (pools: string[]) => JSON.stringify({ data: pools.map((a, i) => ({ attributes: { address: a, volume_usd: { h24: String(1000 * (i + 1)) }, transactions: { h24: { buys: 3, sells: 2 } } } })) });

describe("GeckoTerminalVolumes", () => {
  it("fetches in batches of 30, caches, and parses volume and tx counts", async () => {
    const calls: string[] = [];
    const http = new HttpClient((async (u: string) => {
      calls.push(u);
      const pools = u.split("/multi/")[1]!.split(",");
      return new Response(body(pools), { status: 200, headers: { "content-type": "application/json" } });
    }) as never);
    const v = new GeckoTerminalVolumes(http);
    const pools = Array.from({ length: 31 }, (_, i) => P(i + 1));
    const r = await v.get(pools, { timeoutMs: 10_000 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.split(",")).toHaveLength(30);
    expect(r.get(P(1))).toMatchObject({ usd24h: 1000, txs24h: 5, source: "GeckoTerminal" });
    await v.get(pools, { timeoutMs: 10_000 });
    expect(calls).toHaveLength(2); // cached
  }, 20_000);

  it("never holds the caller longer than timeoutMs and backs off after 429", async () => {
    let n = 0;
    const slow = new HttpClient((async () => {
      n++;
      await new Promise((r) => setTimeout(r, 400));
      return new Response("{}", { status: 429 });
    }) as never);
    const v = new GeckoTerminalVolumes(slow);
    const t0 = Date.now();
    const r = await v.get([P(1)], { timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(300);
    expect(r.size).toBe(0);
    await new Promise((r2) => setTimeout(r2, 600));
    await v.get([P(2)], { timeoutMs: 50 });
    await new Promise((r2) => setTimeout(r2, 100));
    expect(n).toBe(1); // blocked after the 429
  });
});
