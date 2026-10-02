/**
 * Site snapshot replay (vite.config.ts, site mode). Imported first by site-main.tsx, before the app:
 * API requests are answered from data captured at build time, the live stream replays its captured
 * state once, and pages that write the address bar leave it alone.
 */
import data from "virtual:skein-site";
import { makeKeyOf } from "./keys";

const assets = (data.get["/api/assets"] as { assets: { symbol: string; address: string }[] }).assets;
const keyOf = makeKeyOf(assets);
const MISSING = { error: { code: "SNAPSHOT", message: "Not in this snapshot. It holds full detail for a sample of assets; run Skein locally for everything." } };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href, "https://snapshot.invalid");
  if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
  const signal = init?.signal;
  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    // A short pause, so loading states show as they would against the server.
    const t = setTimeout(() => {
      const body = data.get[keyOf(url.pathname, url.search)];
      resolve(body === undefined ? reply(404, MISSING) : reply(200, body));
    }, 160);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(new DOMException("Aborted", "AbortError"))));
  });
};

type Tick = { id?: string; key?: string; a0?: { key: string }; a1?: { key: string } };
type Listener = (e: MessageEvent) => void;

/** Replays the captured stream state once (no further updates), like a connection that went quiet. */
class SnapshotEventSource {
  readonly url: string;
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Set<Listener>>();
  constructor(url: string) {
    this.url = url;
    setTimeout(() => this.replay(), 200);
  }
  addEventListener(type: string, fn: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.get(type)?.delete(fn);
  }
  close() {
    this.readyState = 2;
  }
  private emit(type: string, payload: unknown) {
    if (this.readyState === 2) return;
    const e = new MessageEvent(type, { data: JSON.stringify(payload) });
    this.listeners.get(type)?.forEach((fn) => fn(e));
  }
  private replay() {
    if (this.readyState === 2) return;
    this.readyState = 1;
    this.onopen?.();
    const q = new URL(this.url, "https://snapshot.invalid").searchParams;
    const pairs = new Set((q.get("pairs") ?? "").split(",").filter(Boolean));
    const prices = new Set((q.get("prices") ?? "").split(",").filter(Boolean));
    const s = data.stream as { pairs: Tick[]; prices: Tick[]; pollMs: number };
    this.emit("snapshot", {
      pollMs: s.pollMs,
      pairs: s.pairs.filter((p) => pairs.has(p.a0?.key ?? "") || pairs.has(p.a1?.key ?? "")),
      prices: s.prices.filter((p) => prices.has(p.key ?? "")),
    });
    if (data.block) this.emit("block", { block: data.block });
  }
}
Object.defineProperty(window, "EventSource", { value: SnapshotEventSource, configurable: true, writable: true });

// Pages that mirror their state into the URL (Compare) keep the artifact address as it is.
const replace = history.replaceState.bind(history);
history.replaceState = (state: unknown, unused: string, url?: string | URL | null) => {
  if (typeof url === "string" && url.startsWith("/")) return;
  replace(state, unused, url);
};
