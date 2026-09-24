import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { diffRegistries } from "../../src/registry/diff.js";
import { loadAssetRegistry } from "../../src/registry/registry.js";
import { normalizeRobinhoodAsset, sanitizeLabel } from "../../src/registry/robinhoodRegistry.js";
import { buildSnapshot, parseSnapshot, SnapshotError } from "../../src/registry/snapshot.js";
import { HttpClient } from "../../src/lib/http.js";
import {
  AAPL,
  BLOCK,
  baselineSnapshot,
  defaultWorld,
  FakeChainReader,
  NOW,
  NVDA,
  RHJ_ASSETS,
  rhjAsset,
  testStack,
  validated,
} from "../fixtures/world.js";

const noHttp = new HttpClient(() => Promise.reject(new Error("offline")));

describe("normalizeRobinhoodAsset", () => {
  it("normalizes a valid entry: checksum address, lowercase uid, exact multiplier", () => {
    const n = normalizeRobinhoodAsset(rhjAsset("NVDA", NVDA.toLowerCase() as never, 1, "1.000775159164630595"));
    expect("entry" in n).toBe(true);
    if (!("entry" in n)) return;
    expect(n.entry.address).toBe(getAddress(NVDA));
    expect(n.entry.multiplierE18).toBe(1000775159164630595n);
    expect(n.entry.uid).toMatch(/^0x0{63}1$/);
  });

  it("excludes entries without a 4663 deployment, with two 4663 addresses, or an unparseable multiplier", () => {
    const none = rhjAsset("X", NVDA, 9, "1", { deployments: [{ contractAddress: NVDA, chainId: 1 }] as never });
    const two = rhjAsset("Y", NVDA, 9, "1", { deployments: [{ contractAddress: NVDA, chainId: 4663 }, { contractAddress: AAPL, chainId: 4663 }] as never });
    const bad = rhjAsset("Z", NVDA, 9, "1.2.3");
    expect(normalizeRobinhoodAsset(none)).toMatchObject({ issue: { code: "NO_CHAIN_DEPLOYMENT", effect: "EXCLUDED" } });
    expect(normalizeRobinhoodAsset(two)).toMatchObject({ issue: { code: "MULTIPLE_CHAIN_DEPLOYMENTS" } });
    expect(normalizeRobinhoodAsset(bad)).toMatchObject({ issue: { code: "BAD_MULTIPLIER" } });
  });

  it("flags non-18 decimals and strips control / bidi characters from labels", () => {
    const n = normalizeRobinhoodAsset(rhjAsset("NVDA", NVDA, 1, "1", { tokenDecimals: 6, tokenName: "NVIDIA‮ evil\u0007" }));
    if (!("entry" in n)) throw new Error("expected entry");
    expect(n.flags.map((f) => f.code)).toContain("UNEXPECTED_DECIMALS");
    expect(n.entry.name).toBe("NVIDIA evil");
    expect(sanitizeLabel("a".repeat(500)).length).toBe(120);
  });

  it("keeps logo URLs only on Robinhood's CDN", () => {
    const ok = normalizeRobinhoodAsset(rhjAsset("A", NVDA, 1, "1", { logoUrl: "https://cdn.robinhood.com/x.png" }));
    const evil = normalizeRobinhoodAsset(rhjAsset("A", NVDA, 1, "1", { logoUrl: "https://evil.example/x.png" }));
    expect("entry" in ok && ok.entry.logoUrl).toBe("https://cdn.robinhood.com/x.png");
    expect("entry" in evil && evil.entry.logoUrl).toBeNull();
  });
});

describe("validateRobinhoodAssetRegistry", () => {
  it("accepts the fixture registry", () => {
    const v = validated();
    expect(v.entries).toHaveLength(RHJ_ASSETS.length);
    expect(v.issues).toEqual([]);
  });

  it("excludes EVERY entry involved in a duplicate address, uid or symbol", () => {
    const dupAddr = validated([...RHJ_ASSETS, rhjAsset("NEW", NVDA, 99, "1")]);
    expect(dupAddr.entries.find((e) => e.address === NVDA)).toBeUndefined();
    expect(dupAddr.issues.map((i) => i.code)).toContain("DUPLICATE_ADDRESS");

    const dupSym = validated([...RHJ_ASSETS, rhjAsset("NVDA", getAddress("0x00000000000000000000000000000000000000c1"), 98, "1")]);
    expect(dupSym.entries.filter((e) => e.symbol === "NVDA")).toHaveLength(0);
    expect(dupSym.issues.map((i) => i.code)).toContain("DUPLICATE_SYMBOL");
  });

  it("drops inactive listings from the canonical set", () => {
    const v = validated([...RHJ_ASSETS.slice(1), rhjAsset("NVDA", NVDA, 1, "1", { status: "ASSET_STATUS_INACTIVE" })]);
    expect(v.entries.find((e) => e.address === NVDA)).toBeUndefined();
    expect(v.issues).toContainEqual(expect.objectContaining({ code: "NOT_ACTIVE" }));
  });
});

describe("diffRegistries (change detection)", () => {
  const base = validated().entries;
  const next = (assets: typeof RHJ_ASSETS) => diffRegistries(base, validated(assets).entries);

  it("no changes → empty diff", () => {
    expect(next(RHJ_ASSETS).changes).toEqual([]);
  });

  it("detects added and removed tokens (not identity changes)", () => {
    const d = next([...RHJ_ASSETS.slice(1), rhjAsset("NEWX", getAddress("0x00000000000000000000000000000000000000e1"), 77, "1")]);
    expect(d.changes.map((c) => c.kind).sort()).toEqual(["ADDED", "REMOVED"]);
    expect(d.identityChangeCount).toBe(0);
  });

  it("flags a changed contract address for the same uid as an untrusted IDENTITY change", () => {
    const moved = getAddress("0x00000000000000000000000000000000000000d1");
    const d = next(RHJ_ASSETS.map((a) => (a.tokenSymbol === "NVDA" ? rhjAsset("NVDA", moved, 1, a.currentMultiplier) : a)));
    expect(d.changes[0]).toMatchObject({ kind: "ADDRESS_CHANGED", identity: true, before: NVDA, after: moved });
    expect(d.untrustedAddresses.has(moved.toLowerCase())).toBe(true);
  });

  it("flags uid change, symbol reassignment and decimals change as identity changes", () => {
    const uidChanged = next(RHJ_ASSETS.map((a) => (a.tokenSymbol === "AAPL" ? rhjAsset("AAPL", AAPL, 555, a.currentMultiplier) : a)));
    expect(uidChanged.changes[0]?.kind).toBe("UID_CHANGED");
    const reassigned = next(RHJ_ASSETS.map((a) => (a.tokenSymbol === "AAPL" ? rhjAsset("AAPL", getAddress("0x00000000000000000000000000000000000000d2"), 556, "1") : a)));
    expect(reassigned.changes.map((c) => c.kind)).toContain("SYMBOL_REASSIGNED");
    const dec = next(RHJ_ASSETS.map((a) => (a.tokenSymbol === "AAPL" ? { ...a, tokenDecimals: 6 } : a)));
    expect(dec.changes[0]).toMatchObject({ kind: "DECIMALS_CHANGED", identity: true });
  });

  it("reports metadata and multiplier changes without distrusting the token", () => {
    const d = next(RHJ_ASSETS.map((a) => (a.tokenSymbol === "NVDA" ? { ...a, tokenName: "renamed", currentMultiplier: "1.5" } : a)));
    expect(d.changes.map((c) => c.kind).sort()).toEqual(["METADATA_CHANGED", "MULTIPLIER_CHANGED"]);
    expect(d.untrustedAddresses.size).toBe(0);
  });
});

describe("registry snapshot", () => {
  it("round-trips through JSON with a verified content hash", () => {
    const s = baselineSnapshot();
    const json = JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    const back = parseSnapshot(json);
    expect(back.contentHash).toBe(s.contentHash);
    expect(back.entries[0]!.multiplierE18).toBe(s.entries[0]!.multiplierE18);
  });

  it("detects a hand-edited snapshot", () => {
    const s = baselineSnapshot();
    const json = JSON.parse(JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    json.entries[0].address = "0x0000000000000000000000000000000000000bad";
    expect(() => parseSnapshot(json)).toThrow(SnapshotError);
  });

  it("hash is independent of entry order and address case", () => {
    const e = validated().entries;
    expect(buildSnapshot([...e].reverse(), "t").contentHash).toBe(buildSnapshot(e, "t").contentHash);
  });
});

describe("loadAssetRegistry", () => {
  it("LIVE mode: canonical = core assets + listed Stock Tokens; lookup is case-insensitive", async () => {
    const { registry } = await testStack();
    expect(registry.status.mode).toBe("LIVE");
    expect(registry.canonical()).toHaveLength(3 + RHJ_ASSETS.length);
    expect(registry.get(4663, NVDA.toLowerCase() as never)?.symbol).toBe("NVDA");
    expect(registry.get(4663, null)?.type).toBe("NATIVE");
    expect(registry.get(4663, getAddress("0x0000000000000000000000000000000000000abc"))).toBeUndefined();
  });

  it("SNAPSHOT mode when the live API fails, with the snapshot's age exposed", async () => {
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    const { registry } = await testStack({ liveFails: true, now: later });
    expect(registry.status.mode).toBe("SNAPSHOT");
    expect(registry.status.liveError).toContain("503");
    expect(registry.status.freshness.status).toBe("STALE");
  });

  it("fails loudly when neither live data nor a snapshot exists", async () => {
    await expect(testStack({ liveFails: true, baseline: null })).rejects.toThrow(/registry unavailable/);
  });

  it("excludes identity-changed tokens from the canonical set", async () => {
    const moved = getAddress("0x00000000000000000000000000000000000000d1");
    const { registry } = await testStack({ assets: RHJ_ASSETS.map((a) => (a.tokenSymbol === "NVDA" ? rhjAsset("NVDA", moved, 1, a.currentMultiplier) : a)) });
    const asset = registry.get(4663, moved)!;
    expect(asset.canonical).toBe(false);
    expect(asset.verificationStatus).toBe("CONFLICT");
    expect(registry.canonical().some((a) => a.address === moved)).toBe(false);
  });

  it("onchain verification upgrades matches and rejects mismatches", async () => {
    const world = defaultWorld();
    world.meta.set(AAPL.toLowerCase(), { ...world.meta.get(AAPL.toLowerCase()), registry: getAddress("0x00000000000000000000000000000000000000ee") });
    const { registry } = await testStack({ world, verifyOnchain: true });
    expect(registry.get(4663, NVDA)?.verificationStatus).toBe("VERIFIED_ONCHAIN");
    expect(registry.get(4663, AAPL)).toMatchObject({ canonical: false, verificationStatus: "CONFLICT" });
    expect(registry.status.onchain?.mismatched[0]?.reasons).toEqual(["registry"]);
  });

  it("an RPC failure during verification is not treated as a mismatch", async () => {
    const reader = new FakeChainReader();
    reader.world.rpcDown = true;
    const v = validated();
    const registry = await loadAssetRegistry({ http: noHttp, baseline: null, loadLive: async () => v, reader, blockNumber: BLOCK.number, now: () => NOW });
    expect(registry.status.onchain).toMatchObject({ unreadable: RHJ_ASSETS.length, mismatched: [] });
    expect(registry.get(4663, NVDA)?.canonical).toBe(true);
  });
});
