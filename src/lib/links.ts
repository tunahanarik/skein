import type { TrustedLink } from "../model/opportunity.js";

/**
 * Turn a URL from a protocol API into a link we will render, or null.
 * Only https URLs whose host is exactly an allowlisted host (or a subdomain of one) pass.
 * API data is untrusted: an API response must not be able to point users at a lookalike
 * domain, an http:// page, a javascript: URL or a URL with embedded credentials.
 */
export function toTrustedLink(raw: unknown, allowedHosts: readonly string[]): TrustedLink | null {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.port !== "") return null;
  const host = url.hostname.toLowerCase();
  const ok = allowedHosts.some((allowed) => {
    const a = allowed.toLowerCase();
    return host === a || host.endsWith("." + a);
  });
  return ok ? { url: url.toString(), host } : null;
}
