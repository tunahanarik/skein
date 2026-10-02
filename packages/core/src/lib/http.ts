/**
 * Minimal HTTP JSON client for upstream APIs. Every response is:
 *  - time-limited (AbortSignal timeout),
 *  - size-limited (Content-Length and actual body length),
 *  - runtime-validated by the caller's zod schema before anyone reads it.
 * Credentials are never sent. Retries only on 429/5xx/network errors.
 */
import type { z } from "zod";

export interface HttpOptions {
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  init?: RequestInit;
}

export interface HttpResult<T> {
  data: T;
  url: string;
  status: number;
  fetchedAt: string;
  bytes: number;
}

export class HttpError extends Error {
  override readonly name = "HttpError";
  constructor(
    message: string,
    readonly url: string,
    readonly status: number | null,
    readonly kind: "HTTP_STATUS" | "TIMEOUT" | "TOO_LARGE" | "BAD_JSON" | "SCHEMA" | "NETWORK",
  ) {
    super(message);
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const DEFAULTS = { timeoutMs: 15_000, maxBytes: 2_000_000, retries: 2 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpClient {
  constructor(private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i)) {}

  async getJson<S extends z.ZodType>(url: string, schema: S, opts: HttpOptions = {}): Promise<HttpResult<z.infer<S>>> {
    const { timeoutMs, maxBytes, retries } = { ...DEFAULTS, ...opts };
    let lastError: HttpError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(500 * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          ...opts.init,
          credentials: "omit",
          redirect: "error", // an upstream redirect is unexpected; don't follow it silently
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        lastError = new HttpError(`${timeout ? "timeout" : "network error"}: ${(e as Error).message}`, url, null, timeout ? "TIMEOUT" : "NETWORK");
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new HttpError(`HTTP ${res.status}`, url, res.status, "HTTP_STATUS");
        continue;
      }
      if (res.status !== 200) throw new HttpError(`HTTP ${res.status}`, url, res.status, "HTTP_STATUS");
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > maxBytes) throw new HttpError(`response ${declared} B exceeds ${maxBytes} B`, url, res.status, "TOO_LARGE");
      const text = await res.text();
      if (text.length > maxBytes) throw new HttpError(`response ${text.length} B exceeds ${maxBytes} B`, url, res.status, "TOO_LARGE");
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new HttpError("response is not JSON", url, res.status, "BAD_JSON");
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new HttpError(`schema mismatch: ${parsed.error.message.slice(0, 300)}`, url, res.status, "SCHEMA");
      return { data: parsed.data, url, status: res.status, fetchedAt: new Date().toISOString(), bytes: text.length };
    }
    throw lastError ?? new HttpError("request failed", url, null, "NETWORK");
  }
}
