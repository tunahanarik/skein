import { describe, expect, it } from "vitest";
import { HttpClient } from "@skein/core/lib/http";
import { MorphoApiClient, MorphoApiError, apiMarketSchema } from "../src/morpho/api.js";
import { fixtureMarkets } from "@skein/testkit/morpho";

const respond = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe("Morpho API client", () => {
  const good = fixtureMarkets().nvdaOk.apiRaw;

  it("parses a page and keeps BigInt scalars exact (string above 2^53, number below)", async () => {
    const raw = { ...good, state: { ...(good.state as object), collateralAssets: "13207834825854562348", supplyAssets: 101132 } };
    const api = new MorphoApiClient(new HttpClient(respond({ data: { markets: { pageInfo: { countTotal: 1, count: 1 }, items: [raw] } } })));
    const page = await api.markets(4663);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.state!.collateralAssets).toBe(13207834825854562348n);
    expect(page.items[0]!.state!.supplyAssets).toBe(101132n);
  });

  it("rejects an unsafe JSON number (precision already lost) instead of accepting a wrong value", () => {
    const r = apiMarketSchema.safeParse({ ...good, state: { ...(good.state as object), supplyAssets: 2 ** 60 } });
    expect(r.success).toBe(false);
  });

  it("drops a malformed market but keeps the rest of the page", async () => {
    const bad = { ...good, marketId: "not-an-id" };
    const api = new MorphoApiClient(new HttpClient(respond({ data: { markets: { pageInfo: { countTotal: 2, count: 2 }, items: [bad, good] } } })));
    const page = await api.markets(4663);
    expect(page.items).toHaveLength(1);
    expect(page.rejected).toEqual([expect.objectContaining({ index: 0 })]);
  });

  it("tolerates missing optional fields (null state, no warnings, no rewards)", async () => {
    const sparse = { ...good, state: null, warnings: null, listed: null };
    const r = apiMarketSchema.parse(sparse);
    expect(r.state).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(r.listed).toBeNull();
  });

  it("throws on GraphQL errors, a malformed envelope, or an HTTP failure", async () => {
    await expect(new MorphoApiClient(new HttpClient(respond({ errors: [{ message: "Query is too complex" }] }))).markets(4663)).rejects.toBeInstanceOf(MorphoApiError);
    await expect(new MorphoApiClient(new HttpClient(respond({ data: { markets: { items: "nope" } } }))).markets(4663)).rejects.toThrow(/unexpected markets shape/);
    await expect(new MorphoApiClient(new HttpClient(respond({}, 404))).markets(4663)).rejects.toThrow(/HTTP 404/);
  });

  it("surfaces a timeout as an error (no partial silent result)", async () => {
    const timeout = async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    };
    await expect(new MorphoApiClient(new HttpClient(timeout)).markets(4663)).rejects.toMatchObject({ kind: "TIMEOUT" });
  });

  it("paginates until countTotal", async () => {
    let calls = 0;
    const items = Array.from({ length: 200 }, () => good);
    const http = new HttpClient(async (_u, init) => {
      calls++;
      const skip = JSON.parse(String(init?.body)).variables.skip;
      return new Response(JSON.stringify({ data: { markets: { pageInfo: { countTotal: 201, count: 1 }, items: skip === 0 ? items : [good] } } }));
    });
    const page = await new MorphoApiClient(http).markets(4663);
    expect(calls).toBe(2);
    expect(page.items).toHaveLength(201); // duplicates are the adapter's job to detect
  });
});
