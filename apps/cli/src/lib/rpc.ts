/**
 * Read-only client for validation scripts. There is no wallet client and no private key
 * anywhere in this repo: these scripts can only read.
 *
 * The public RPC answers HTTP 429 quickly (docs/research/network.md), so requests are
 * batched (≤10 per HTTP call) and retried with backoff.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { PUBLIC_RPC_URL, robinhoodChain } from "@skein/networks/chains";

export function rpcUrl(): string {
  return process.env.ROBINHOOD_RPC_URL?.trim() || PUBLIC_RPC_URL;
}

export function makeClient(): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: http(rpcUrl(), {
      batch: { batchSize: 10, wait: 50 },
      retryCount: 5,
      retryDelay: 1500,
      timeout: 30_000,
    }),
    batch: { multicall: { batchSize: 4_096, wait: 20 } },
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET JSON with a timeout and a couple of retries on 429/5xx. Never sends credentials. */
export async function getJson<T = unknown>(url: string, init: RequestInit = {}): Promise<{ status: number; body: T; fetchedAt: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000), credentials: "omit" });
    const fetchedAt = new Date().toISOString();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.slice(0, 500);
    }
    return { status: res.status, body: body as T, fetchedAt };
  }
}

export async function postGraphql<T = unknown>(url: string, query: string, variables: Record<string, unknown> = {}) {
  return getJson<{ data?: T; errors?: { message: string }[] }>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
}
