import { describe, expect, it } from "vitest";
import { clientKey } from "../src/api.js";
import { RateLimiter } from "../src/rateLimit.js";

describe("rate limit key", () => {
  it("without a trusted proxy, X-Forwarded-For is ignored", () => {
    expect(clientKey("203.0.113.9", "1.2.3.4", false)).toBe("203.0.113.9");
  });

  it("behind our proxy the right-most entry counts; a forged left part changes nothing (SRV-4)", () => {
    expect(clientKey("127.0.0.1", "203.0.113.9", true)).toBe("203.0.113.9");
    expect(clientKey("127.0.0.1", "6.6.6.6, 7.7.7.7, 203.0.113.9", true)).toBe("203.0.113.9");
    expect(clientKey("127.0.0.1", ["9.9.9.9", "203.0.113.9"], true)).toBe("203.0.113.9");
    expect(clientKey("127.0.0.1", "not-an-ip", true)).toBe("127.0.0.1");
  });

  it("IPv6 clients share one key per /64; mapped IPv4 is plain IPv4 (SRV-5)", () => {
    expect(clientKey("2001:db8:aa:bb:1:2:3:4", undefined, false)).toBe("2001:db8:aa:bb::/64");
    expect(clientKey("2001:db8:aa:bb::9", undefined, false)).toBe("2001:db8:aa:bb::/64");
    expect(clientKey("2001:db8::1", undefined, false)).toBe("2001:db8:0:0::/64");
    expect(clientKey("::ffff:203.0.113.9", undefined, false)).toBe("203.0.113.9");
  });
});

describe("RateLimiter", () => {
  it("refills over time", () => {
    let t = 0;
    const l = new RateLimiter(() => t);
    expect([l.take("a", 2), l.take("a", 2), l.take("a", 2)]).toEqual([true, true, false]);
    t = 30_000; // half a minute: one token back
    expect(l.take("a", 2)).toBe(true);
  });

  it("at its bound drops the least recently used buckets, never everyone's limit (SRV-5)", () => {
    let t = 0;
    const l = new RateLimiter(() => t, 10);
    expect(l.take("abuser", 1)).toBe(true);
    expect(l.take("abuser", 1)).toBe(false);
    for (let i = 0; i < 20; i++) {
      t++;
      l.take(`k${i}`, 1);
      l.take("abuser", 1); // stays recently used, so it is never the one evicted
    }
    expect(l.size).toBeLessThanOrEqual(10);
    expect(l.take("abuser", 1)).toBe(false);
  });
});
