/**
 * Live prices in the browser: one EventSource to /api/stream for everything the page watches.
 * Components call useLive({ pairs, prices }); the union of all requests is streamed, and the
 * connection is reopened (debounced) when that union changes. Without EventSource (tests, very
 * old browsers) the hook simply returns nothing.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { PairTick, PriceTick } from "../../src/server/live.js";

export type { PairTick, PriceTick };

interface State {
  pairs: Map<string, PairTick>;
  prices: Map<string, PriceTick>;
  /** Direction of the last change per id (for flashing). */
  moves: Map<string, { dir: 1 | -1; at: number }>;
  connected: boolean;
  /** When the last poll was read (any "block" event), and which block. */
  lastAt: number | null;
  block: string | null;
  pollMs: number;
}

let state: State = { pairs: new Map(), prices: new Map(), moves: new Map(), connected: false, lastAt: null, block: null, pollMs: 2000 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  emit();
};

const requests = new Map<number, { pairs: string[]; prices: string[] }>();
let nextId = 1;
let es: EventSource | null = null;
let openKey = "";
let timer: ReturnType<typeof setTimeout> | null = null;

function union() {
  const pairs = new Set<string>();
  const prices = new Set<string>();
  for (const r of requests.values()) {
    r.pairs.forEach((x) => pairs.add(x));
    r.prices.forEach((x) => prices.add(x));
  }
  return { pairs: [...pairs].sort().slice(0, 12), prices: [...prices].sort().slice(0, 12) };
}

function move(id: string, prev: string | null | undefined, next: string | null | undefined, moves: Map<string, { dir: 1 | -1; at: number }>) {
  if (prev && next && prev !== next) moves.set(id, { dir: Number(next) > Number(prev) ? 1 : -1, at: Date.now() });
}

function reconnect() {
  const u = union();
  const key = `${u.pairs.join(",")}|${u.prices.join(",")}`;
  if (key === openKey && es) return;
  es?.close();
  es = null;
  openKey = key;
  if ((!u.pairs.length && !u.prices.length) || typeof EventSource === "undefined") return set({ connected: false });
  const q = new URLSearchParams();
  if (u.pairs.length) q.set("pairs", u.pairs.join(","));
  if (u.prices.length) q.set("prices", u.prices.join(","));
  const src = new EventSource(`/api/stream?${q.toString()}`);
  es = src;
  src.onopen = () => set({ connected: true });
  src.onerror = () => set({ connected: false });
  const onPair = (p: PairTick) => {
    const pairs = new Map(state.pairs);
    const moves = new Map(state.moves);
    move(p.id, pairs.get(p.id)?.price, p.price, moves);
    pairs.set(p.id, p);
    return { pairs, moves };
  };
  src.addEventListener("snapshot", (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { pairs: PairTick[]; prices: PriceTick[]; pollMs: number };
    const pairs = new Map(state.pairs);
    const prices = new Map(state.prices);
    d.pairs.forEach((p) => pairs.set(p.id, p));
    d.prices.forEach((p) => prices.set(p.key, p));
    set({ pairs, prices, pollMs: d.pollMs, connected: true, lastAt: Date.now() });
  });
  src.addEventListener("pair", (e) => set(onPair(JSON.parse((e as MessageEvent).data) as PairTick)));
  src.addEventListener("block", (e) => set({ block: (JSON.parse((e as MessageEvent).data) as { block: string }).block, lastAt: Date.now(), connected: true }));
  src.addEventListener("price", (e) => {
    const p = JSON.parse((e as MessageEvent).data) as PriceTick;
    const prices = new Map(state.prices);
    const moves = new Map(state.moves);
    move(p.key, prices.get(p.key)?.usd, p.usd, moves);
    prices.set(p.key, p);
    set({ prices, moves });
  });
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(reconnect, 250);
}

/** Watches pairs of `pairs` assets and USD prices of `prices` assets (registry keys or symbols). */
export function useLive(req: { pairs?: string[]; prices?: string[] }): State {
  const key = `${(req.pairs ?? []).join(",")}|${(req.prices ?? []).join(",")}`;
  useEffect(() => {
    const id = nextId++;
    requests.set(id, { pairs: req.pairs ?? [], prices: req.prices ?? [] });
    schedule();
    return () => {
      requests.delete(id);
      schedule();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state,
    () => state,
  );
}

/** Pairs that include `assetKey`, most liquid first, oriented as "1 asset = x other". */
export function usePairsFor(live: State, assetKey: string | null) {
  return useMemo(() => {
    if (!assetKey) return [];
    return [...live.pairs.values()]
      .filter((p) => p.a0.key === assetKey || p.a1.key === assetKey)
      .map((p) => {
        const base = p.a0.key === assetKey;
        const m = live.moves.get(p.id) ?? null;
        // Moves are tracked on a1-per-a0; flip them when the asset is a1 (the inverse is shown).
        return { tick: p, other: base ? p.a1 : p.a0, price: base ? p.price : p.inverse, move: m && !base ? { ...m, dir: (-m.dir) as 1 | -1 } : m };
      })
      .sort((a, b) => Number(b.tick.tvlUsd ?? 0) - Number(a.tick.tvlUsd ?? 0));
  }, [live, assetKey]);
}
