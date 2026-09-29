/**
 * Browser-only alerts: price above/below, or an opportunity's headline rate above/below.
 * Stored in localStorage (no account, nothing sent anywhere but our own read API). Checked every
 * CHECK_MS while the app is open; a triggered alert shows in the app and, if the user allowed it,
 * as a browser notification. One-shot: a triggered alert stays triggered until re-armed.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "./api";

export type AlertKind = "PRICE" | "RATE";
export interface Alert {
  id: string;
  kind: AlertKind;
  assetRef: string; // registry address (lowercase)
  symbol: string;
  /** RATE only: the card to watch, and its label at creation. */
  cardId?: string;
  label: string;
  op: "ABOVE" | "BELOW";
  /** USD for PRICE, percent for RATE. */
  threshold: number;
  createdAt: number;
  triggeredAt?: number;
  lastValue?: number;
}

const KEY = "hoodmap.alerts";
export const CHECK_MS = 120_000;
const MAX_ALERTS = 20;

function load(): Alert[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? (v as Alert[]).filter((a) => a && typeof a.id === "string" && /^0x[0-9a-f]{40}$/.test(a.assetRef) && Number.isFinite(a.threshold)).slice(0, MAX_ALERTS) : [];
  } catch {
    return [];
  }
}
function save(a: Alert[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* ignore */
  }
}

export const crossed = (a: Pick<Alert, "op" | "threshold">, v: number) => (a.op === "ABOVE" ? v >= a.threshold : v <= a.threshold);

interface Ctx {
  alerts: Alert[];
  add(a: Omit<Alert, "id" | "createdAt">): void;
  remove(id: string): void;
  rearm(id: string): void;
  fired: Alert[];
  dismissFired(): void;
}
const AlertsCtx = createContext<Ctx | null>(null);

export function AlertsProvider({ children }: { children: ReactNode }) {
  const [alerts, setAlerts] = useState<Alert[]>(load);
  const [fired, setFired] = useState<Alert[]>([]);
  const ref = useRef(alerts);
  ref.current = alerts;
  const update = useCallback((next: Alert[]) => {
    setAlerts(next);
    save(next);
  }, []);

  const check = useCallback(async () => {
    const armed = ref.current.filter((a) => !a.triggeredAt);
    if (!armed.length) return;
    const byAsset = new Map<string, Alert[]>();
    for (const a of armed) byAsset.set(a.assetRef, [...(byAsset.get(a.assetRef) ?? []), a]);
    const updates = new Map<string, Partial<Alert>>();
    for (const [asset, list] of byAsset) {
      let v: Awaited<ReturnType<typeof api.asset>>;
      try {
        v = await api.asset(asset);
      } catch {
        continue;
      }
      const cards = v.categories.flatMap((c) => c.subcategories.flatMap((s) => s.cards));
      for (const a of list) {
        const value = a.kind === "PRICE" ? (v.price?.usd ? Number(v.price.usd) : null) : (() => {
          const c = cards.find((x) => x.cardId === a.cardId);
          return c?.headline ? Number(c.headline.value) / 1e16 : null;
        })();
        if (value === null) continue;
        updates.set(a.id, crossed(a, value) ? { lastValue: value, triggeredAt: Date.now() } : { lastValue: value });
      }
    }
    if (!updates.size) return;
    const next = ref.current.map((a) => (updates.has(a.id) ? { ...a, ...updates.get(a.id) } : a));
    const newly = next.filter((a) => a.triggeredAt && !ref.current.find((o) => o.id === a.id)?.triggeredAt);
    update(next);
    if (newly.length) {
      setFired((f) => [...f, ...newly]);
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted") for (const a of newly) new Notification("Hoodmap", { body: `${a.symbol}: ${a.label}` });
      } catch {
        /* notifications unavailable */
      }
    }
  }, [update]);

  useEffect(() => {
    void check();
    const id = setInterval(() => void check(), CHECK_MS);
    return () => clearInterval(id);
  }, [check]);

  const value = useMemo<Ctx>(
    () => ({
      alerts,
      fired,
      add: (a) => {
        if (ref.current.length >= MAX_ALERTS) return;
        update([...ref.current, { ...a, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now() }]);
        try {
          if (typeof Notification !== "undefined" && Notification.permission === "default") void Notification.requestPermission();
        } catch {
          /* ignore */
        }
        setTimeout(() => void check(), 0);
      },
      remove: (id) => update(ref.current.filter((a) => a.id !== id)),
      rearm: (id) => update(ref.current.map((a) => (a.id === id ? { ...a, triggeredAt: undefined } as Alert : a))),
      dismissFired: () => setFired([]),
    }),
    [alerts, fired, update, check],
  );
  return <AlertsCtx.Provider value={value}>{children}</AlertsCtx.Provider>;
}

export function useAlerts(): Ctx {
  const v = useContext(AlertsCtx);
  if (!v) throw new Error("AlertsProvider missing");
  return v;
}
