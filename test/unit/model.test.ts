import { describe, expect, it } from "vitest";
import { freshness, unixToIso } from "../../src/lib/freshness.js";
import { toTrustedLink } from "../../src/lib/links.js";
import {
  aprToApy,
  apyToApr,
  perSecondRateE18ToApy,
  rewardShare,
  supplyApyFromBorrow,
  utilization,
} from "../../src/lib/rates.js";
import { parseAddress, parseChainId, parseWalletAddress, ValidationError } from "../../src/lib/validation.js";
import { computed, supplied, type DataSource } from "../../src/model/provenance.js";
import { isAuthoritative, requiresDisclosure, weakestStatus } from "../../src/model/verification.js";

const src = (over: Partial<DataSource> = {}): DataSource => ({
  type: "ONCHAIN",
  provider: "robinhood-chain-rpc",
  observedAt: "2026-09-24T06:00:00.000Z",
  ...over,
});

describe("verification status", () => {
  it("only the three verified states are authoritative", () => {
    expect(isAuthoritative("VERIFIED_ONCHAIN")).toBe(true);
    expect(isAuthoritative("VERIFIED_OFFICIAL_DOCS")).toBe(true);
    expect(isAuthoritative("THIRD_PARTY_ONLY")).toBe(false);
    expect(requiresDisclosure("CONFLICT")).toBe(true);
    expect(requiresDisclosure("UNVERIFIED")).toBe(true);
  });

  it("a combination is only as strong as its weakest input", () => {
    expect(weakestStatus(["VERIFIED_ONCHAIN", "THIRD_PARTY_ONLY", "VERIFIED_OFFICIAL_API"])).toBe("THIRD_PARTY_ONLY");
    expect(weakestStatus(["VERIFIED_ONCHAIN", "UNVERIFIED", "CONFLICT"])).toBe("UNVERIFIED");
    expect(weakestStatus([])).toBe("UNVERIFIED");
  });
});

describe("provenance", () => {
  it("a computed value inherits the weakest verification and the oldest timestamp", () => {
    const amount = supplied(1n, src({ sourceTimestamp: "2026-09-24T05:59:00.000Z" }), "VERIFIED_ONCHAIN");
    const price = supplied(2n, src({ type: "THIRD_PARTY_API", provider: "geckoterminal", sourceTimestamp: "2026-09-24T05:00:00.000Z" }), "THIRD_PARTY_ONLY");
    const tvl = computed(2n, "amount*price", [amount, price], "2026-09-24T06:00:00.000Z");
    expect(tvl.origin).toBe("COMPUTED");
    expect(tvl.verification).toBe("THIRD_PARTY_ONLY");
    expect(tvl.source.sourceTimestamp).toBe("2026-09-24T05:00:00.000Z");
    expect(tvl.inputs).toHaveLength(2);
  });
});

describe("freshness", () => {
  const now = new Date("2026-09-24T06:00:00.000Z");

  it("judges age on the source's own timestamp, not on fetch time", () => {
    // Chainlink round 6h old, fetched a second ago; heartbeat 24h
    const v = { source: src({ observedAt: "2026-09-24T05:59:59.000Z", sourceTimestamp: "2026-09-24T00:00:00.000Z" }) };
    expect(freshness(v, 86_400, now)).toEqual({ status: "FRESH", ageSeconds: 21_600 });
    expect(freshness(v, 3_600, now).status).toBe("STALE");
  });

  it("flags timestamps from the future and unparseable ones", () => {
    expect(freshness({ source: src({ sourceTimestamp: "2026-09-24T07:00:00.000Z" }) }, 60, now).status).toBe("FUTURE");
    expect(freshness({ source: src({ observedAt: "yesterday" }) }, 60, now)).toEqual({ status: "UNKNOWN_AGE", ageSeconds: null });
  });

  it("treats a zero contract timestamp as 'never'", () => {
    expect(unixToIso(0n)).toBeNull();
    expect(unixToIso(1790191639)).toBe("2026-09-23T19:27:19.000Z");
  });
});

describe("rates", () => {
  it("APR ↔ APY conversions", () => {
    expect(aprToApy(0.05, 365)).toBeCloseTo(0.051267, 6);
    expect(aprToApy(0.05, Number.POSITIVE_INFINITY)).toBeCloseTo(Math.exp(0.05) - 1, 12);
    expect(apyToApr(aprToApy(0.07, 12), 12)).toBeCloseTo(0.07, 12);
  });

  it("Morpho per-second borrow rate → APY", () => {
    // 1.0908620857e-9/s is Spark's 3.50% savings rate
    expect(perSecondRateE18ToApy(1_090_862_085n)).toBeCloseTo(0.035, 4);
  });

  it("supply APY compounds the borrow rate share (matches the Morpho API formula)", () => {
    // Morpho USDe/USDG market, 2026-09-24: borrowApy 4.538947%, util 90.38%, fee 0
    const s = supplyApyFromBorrow(0.04538947, 0.9038, 0);
    expect(s).toBeCloseTo(0.0409, 3);
    expect(s).not.toBeCloseTo(0.04538947 * 0.9038, 5); // not the naive product
    expect(supplyApyFromBorrow(0.1, 0.5, 1)).toBe(0);
  });

  it("utilization is null, not 0, when nothing is supplied", () => {
    expect(utilization(0n, 0n)).toBeNull();
    expect(utilization(300n, 1000n)).toBeCloseTo(0.3, 9);
  });

  it("reward dependence", () => {
    expect(rewardShare(0.1, 0.07)).toBeCloseTo(0.7, 9);
    expect(rewardShare(0, 0.01)).toBeNull();
  });
});

describe("address and chain id validation", () => {
  it("accepts lowercase and correct checksum, returns checksummed", () => {
    expect(parseAddress("0x5fc5360d0400a0fd4f2af552add042d716f1d168")).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    expect(parseAddress(" 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 ")).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
  });

  it("rejects a bad checksum, wrong length, non-strings and the zero wallet", () => {
    expect(() => parseAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d16A")).toThrow(ValidationError);
    expect(() => parseAddress("0x1234")).toThrow(ValidationError);
    expect(() => parseAddress(42)).toThrow(ValidationError);
    expect(() => parseWalletAddress("0x0000000000000000000000000000000000000000")).toThrow(ValidationError);
  });

  it("parses chain ids from RPC hex, numbers and strings, and enforces the allowlist", () => {
    expect(parseChainId("0x1237", [4663])).toBe(4663);
    expect(parseChainId(4663, [4663])).toBe(4663);
    expect(parseChainId("4663", [4663])).toBe(4663);
    expect(() => parseChainId("0xb626", [4663])).toThrow(/unsupported/); // testnet 46630
    expect(() => parseChainId("robinhood", [4663])).toThrow(ValidationError);
    expect(() => parseChainId(-1, [4663])).toThrow(ValidationError);
  });
});

describe("trusted links", () => {
  const hosts = ["app.morpho.org", "morpho.org"];

  it("allows https links on allowlisted hosts and subdomains", () => {
    expect(toTrustedLink("https://app.morpho.org/robinhood/market/0xabc", hosts)?.host).toBe("app.morpho.org");
  });

  it("rejects lookalikes, http, credentials, ports and script URLs", () => {
    expect(toTrustedLink("https://morpho.org.evil.xyz/", hosts)).toBeNull();
    expect(toTrustedLink("https://evilmorpho.org/", hosts)).toBeNull();
    expect(toTrustedLink("http://app.morpho.org/", hosts)).toBeNull();
    expect(toTrustedLink("https://user:pw@app.morpho.org/", hosts)).toBeNull();
    expect(toTrustedLink("https://app.morpho.org:8443/", hosts)).toBeNull();
    expect(toTrustedLink("javascript:alert(1)", hosts)).toBeNull();
    expect(toTrustedLink({ href: "https://app.morpho.org" }, hosts)).toBeNull();
  });
});
