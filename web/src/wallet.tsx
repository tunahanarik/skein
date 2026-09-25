/**
 * Wallet connection. Browser-extension wallets are discovered with EIP-6963 (MetaMask, Rabby,
 * OKX, Coinbase Wallet, Trust, Robinhood Wallet extension, …), with `window.ethereum` as a
 * fallback. The address is kept in memory only (never in the URL, storage or logs).
 *
 * The page talks to the wallet through a method allowlist: address and chain reads, network
 * switching, eth_call, and eth_sendTransaction — which the wallet always shows to the user to
 * approve. No message or typed-data signing, no permits. Transactions are built and checked
 * in src/swap (Uniswap v3 swaps and the exact approval they need) and src/bridge (LI.FI).
 */
import type { StringKey } from "./i18n";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
}

export interface WalletInfo {
  /** EIP-6963 uuid, or "injected" for window.ethereum. */
  id: string;
  name: string;
  /** data: URI from the wallet itself (EIP-6963), or null. */
  icon: string | null;
  rdns: string | null;
}

const ALLOWED_METHODS = new Set([
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "eth_call",
  "eth_getBalance",
  "eth_getTransactionReceipt",
  "eth_sendTransaction",
]);

function guarded(e: Eip1193): Eip1193 {
  return {
    request: (a) => (ALLOWED_METHODS.has(a.method) ? e.request(a) : Promise.reject(new Error(`method not allowed: ${a.method}`))),
    on: e.on?.bind(e),
    removeListener: e.removeListener?.bind(e),
  };
}

const isAddr = (a: unknown): a is `0x${string}` => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const safeText = (s: unknown, max: number) => (typeof s === "string" ? s.replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, "").slice(0, max) : "");
const safeIcon = (s: unknown) => (typeof s === "string" && /^data:image\/(png|jpeg|webp|svg\+xml|gif)[;,]/i.test(s) && s.length < 200_000 ? s : null);

/** EIP-6963 discovery; the list grows as wallets announce themselves. */
function useDiscoveredWallets(): { info: WalletInfo; provider: Eip1193 }[] {
  const [list, setList] = useState<{ info: WalletInfo; provider: Eip1193 }[]>([]);
  useEffect(() => {
    const onAnnounce = (ev: Event) => {
      const d = (ev as CustomEvent).detail as { info?: Record<string, unknown>; provider?: Eip1193 } | undefined;
      if (!d?.provider || typeof d.provider.request !== "function" || typeof d.info?.uuid !== "string") return;
      const info: WalletInfo = { id: safeText(d.info.uuid, 64), name: safeText(d.info.name, 40) || "Wallet", icon: safeIcon(d.info.icon), rdns: safeText(d.info.rdns, 80) || null };
      setList((l) => (l.some((x) => x.info.id === info.id || (info.rdns && x.info.rdns === info.rdns)) ? l : [...l, { info, provider: d.provider! }]));
    };
    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
  }, []);
  return list;
}

interface WalletState {
  address: `0x${string}` | null;
  source: "connected" | "pasted" | null;
  /** Wallets found in this browser. */
  wallets: WalletInfo[];
  hasInjected: boolean;
  /** Connected wallet (null when only viewing a pasted address). */
  wallet: WalletInfo | null;
  provider: Eip1193 | null;
  chainId: number | null;
  connecting: boolean;
  /** i18n key of the last error, if any. */
  error: StringKey | null;
  pickerOpen: boolean;
  openPicker(): void;
  closePicker(): void;
  connect(id?: string): Promise<void>;
  usePasted(a: string): boolean;
  clear(): void;
}

const Ctx = createContext<WalletState | null>(null);

export function WalletProvider({ children }: { children: ReactNode }) {
  const discovered = useDiscoveredWallets();
  const legacy = useMemo(() => {
    const e = (window as unknown as { ethereum?: Eip1193 }).ethereum;
    return e && typeof e.request === "function" ? e : null;
  }, []);
  const all = useMemo(() => (discovered.length ? discovered : legacy ? [{ info: { id: "injected", name: "Browser wallet", icon: null, rdns: null }, provider: legacy }] : []), [discovered, legacy]);

  const [address, setAddress] = useState<`0x${string}` | null>(null);
  const [source, setSource] = useState<WalletState["source"]>(null);
  const [active, setActive] = useState<{ info: WalletInfo; raw: Eip1193 } | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<StringKey | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const provider = useMemo(() => (active ? guarded(active.raw) : null), [active]);

  const reset = useCallback(() => {
    setAddress(null);
    setSource(null);
    setActive(null);
    setChainId(null);
  }, []);

  useEffect(() => {
    if (!active?.raw.on || source !== "connected") return;
    const raw = active.raw;
    const onAccounts = (accs: unknown) => {
      const a = Array.isArray(accs) ? accs[0] : null;
      if (isAddr(a)) setAddress(a);
      else reset();
    };
    const onChain = (id: unknown) => setChainId(Number(id));
    raw.on!("accountsChanged", onAccounts);
    raw.on!("chainChanged", onChain);
    return () => {
      raw.removeListener?.("accountsChanged", onAccounts);
      raw.removeListener?.("chainChanged", onChain);
    };
  }, [active, source, reset]);

  const connect = useCallback(
    async (id?: string) => {
      const w = id ? all.find((x) => x.info.id === id) : all.length === 1 ? all[0] : undefined;
      if (!w) {
        if (!all.length) setError("wallet.err.noWallet");
        else setPickerOpen(true);
        return;
      }
      setConnecting(true);
      setError(null);
      try {
        const accs = (await w.provider.request({ method: "eth_requestAccounts" })) as unknown[];
        const a = accs?.[0];
        if (!isAddr(a)) throw new Error("no account");
        setActive({ info: w.info, raw: w.provider });
        setAddress(a);
        setSource("connected");
        setChainId(Number(await w.provider.request({ method: "eth_chainId" })));
        setPickerOpen(false);
      } catch (e) {
        setError((e as { code?: number }).code === 4001 ? "wallet.err.declined" : "wallet.err.read");
      } finally {
        setConnecting(false);
      }
    },
    [all],
  );

  const value: WalletState = {
    address,
    source,
    wallets: all.map((w) => w.info),
    hasInjected: all.length > 0,
    wallet: active?.info ?? null,
    provider,
    chainId,
    connecting,
    error,
    pickerOpen,
    openPicker: () => {
      setError(null);
      setPickerOpen(true);
    },
    closePicker: () => setPickerOpen(false),
    connect,
    usePasted: (a) => {
      const v = a.trim();
      if (!isAddr(v)) {
        setError("wallet.err.invalid");
        return false;
      }
      setError(null);
      setActive(null);
      setChainId(null);
      setAddress(v);
      setSource("pasted");
      return true;
    },
    clear: () => {
      reset();
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
