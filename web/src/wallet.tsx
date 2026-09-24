/**
 * Wallet address, in memory only (never in the URL, storage or logs). "Connect" asks an injected
 * EIP-1193 wallet for its address with `eth_requestAccounts` — the only wallet method this app
 * ever calls. It never requests a signature or a transaction.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
}

const ALLOWED_METHODS = new Set(["eth_requestAccounts", "eth_accounts"]);

function injected(): Eip1193 | null {
  const e = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!e || typeof e.request !== "function") return null;
  // Belt and braces: refuse anything but address reads even if code elsewhere tried.
  return { ...e, request: (a) => (ALLOWED_METHODS.has(a.method) ? e.request(a) : Promise.reject(new Error("read-only app"))), on: e.on?.bind(e), removeListener: e.removeListener?.bind(e) } as Eip1193;
}

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);

interface WalletState {
  address: string | null;
  source: "connected" | "pasted" | null;
  hasInjected: boolean;
  connecting: boolean;
  error: string | null;
  connect(): Promise<void>;
  usePasted(a: string): boolean;
  clear(): void;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [source, setSource] = useState<WalletState["source"]>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = useMemo(injected, []);

  useEffect(() => {
    if (!provider?.on || source !== "connected") return;
    const on = (accs: unknown) => {
      const a = Array.isArray(accs) ? accs[0] : null;
      if (isAddr(a)) setAddress(a);
      else {
        setAddress(null);
        setSource(null);
      }
    };
    provider.on("accountsChanged", on);
    return () => provider.removeListener?.("accountsChanged", on);
  }, [provider, source]);

  const connect = useCallback(async () => {
    if (!provider) {
      setError("No browser wallet found. Paste an address instead.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const accs = (await provider.request({ method: "eth_requestAccounts" })) as unknown[];
      const a = accs?.[0];
      if (!isAddr(a)) throw new Error("no account");
      setAddress(a);
      setSource("connected");
    } catch (e) {
      setError((e as { code?: number }).code === 4001 ? "Connection request was declined." : "Could not read an address from the wallet.");
    } finally {
      setConnecting(false);
    }
  }, [provider]);

  const value: WalletState = {
    address,
    source,
    hasInjected: !!provider,
    connecting,
    error,
    connect,
    usePasted: (a) => {
      const v = a.trim();
      if (!isAddr(v)) {
        setError("That is not a valid address (0x followed by 40 hex characters).");
        return false;
      }
      setError(null);
      setAddress(v);
      setSource("pasted");
      return true;
    },
    clear: () => {
      setAddress(null);
      setSource(null);
      setError(null);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletState {
  const v = useContext(Ctx);
  if (!v) throw new Error("WalletProvider missing");
  return v;
}
