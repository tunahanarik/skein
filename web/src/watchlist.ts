/** Watchlist of asset keys, kept in this browser only (localStorage; failures ignored). No accounts. */
import { useCallback, useEffect, useState } from "react";

const KEY = "hoodmap.watchlist";
const EVENT = "hoodmap:watchlist";

function read(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && /^4663:0x[0-9a-f]{40}$/.test(x)).slice(0, 50) : [];
  } catch {
    return [];
  }
}

export function useWatchlist() {
  const [keys, setKeys] = useState<string[]>(read);
  useEffect(() => {
    const on = () => setKeys(read());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  const toggle = useCallback((key: string) => {
    const k = key.toLowerCase();
    const cur = read();
    const next = cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k];
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setKeys(next);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { keys, has: (key: string) => keys.includes(key.toLowerCase()), toggle };
}
