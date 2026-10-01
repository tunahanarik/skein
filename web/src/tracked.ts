/**
 * Tracked wallets: addresses the user chose to follow, kept in this browser only (localStorage).
 * Nothing is sent to our server except when a wallet's portfolio is read, exactly as for a pasted
 * address. An address enters the list only through an explicit "Track" action and leaves with one click.
 */
import { useCallback, useEffect, useState } from "react";

export interface TrackedWallet {
  address: `0x${string}`;
  label: string;
  addedAt: number;
}

const KEY = "skein.tracked";
const EVENT = "skein:tracked";
export const MAX_TRACKED = 20;
const isAddr = (a: unknown): a is `0x${string}` => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
/** A label is the user's own text: one line, no control or bidi characters, bounded. */
export const cleanLabel = (s: string) => s.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "").trim().slice(0, 24);

function read(): TrackedWallet[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is TrackedWallet => !!x && isAddr(x.address))
      .map((x) => ({ address: x.address, label: typeof x.label === "string" ? cleanLabel(x.label) : "", addedAt: Number(x.addedAt) || 0 }))
      .slice(0, MAX_TRACKED);
  } catch {
    return [];
  }
}

function write(list: TrackedWallet[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable: the list just won't persist */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useTracked() {
  const [list, setList] = useState<TrackedWallet[]>(read);
  useEffect(() => {
    const on = () => setList(read());
    window.addEventListener(EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);
  const has = useCallback((a: string) => list.some((x) => x.address.toLowerCase() === a.toLowerCase()), [list]);
  /** Adds (or relabels) a wallet; false when the address is invalid or the list is full. */
  const add = useCallback((address: string, label = ""): boolean => {
    if (!isAddr(address)) return false;
    const cur = read();
    const i = cur.findIndex((x) => x.address.toLowerCase() === address.toLowerCase());
    if (i >= 0) cur[i] = { ...cur[i]!, label: cleanLabel(label) || cur[i]!.label };
    else if (cur.length >= MAX_TRACKED) return false;
    else cur.unshift({ address, label: cleanLabel(label), addedAt: Date.now() });
    write(cur);
    return true;
  }, []);
  const remove = useCallback((address: string) => write(read().filter((x) => x.address.toLowerCase() !== address.toLowerCase())), []);
  return { list, has, add, remove };
}
