/**
 * Registry change detection between a trusted baseline (the committed snapshot) and a newer
 * list (live API). The issuer uid is the stable identity of a listing; the contract address
 * is the identity of the token. Any change that moves one relative to the other is an
 * IDENTITY change and is never auto-trusted.
 */
import type { Address } from "viem";
import type { StockRegistryEntry } from "./robinhoodRegistry.js";

export type RegistryChangeKind =
  | "ADDED" // new uid at a new address
  | "REMOVED" // uid/address no longer listed (or no longer ACTIVE)
  | "ADDRESS_CHANGED" // same uid, different contract address → IDENTITY
  | "UID_CHANGED" // same address, different uid → IDENTITY
  | "SYMBOL_REASSIGNED" // a symbol that belonged to one contract now points at another → IDENTITY
  | "DECIMALS_CHANGED" // → IDENTITY (would change every balance)
  | "METADATA_CHANGED" // name / symbol / isin / logo on the same token
  | "MULTIPLIER_CHANGED"
  | "PENDING_MULTIPLIER_CHANGED";

export interface RegistryChange {
  kind: RegistryChangeKind;
  identity: boolean;
  symbol: string;
  /** Address(es) affected: the new address first when it changed. */
  addresses: Address[];
  before: string | null;
  after: string | null;
}

export interface RegistryDiff {
  changes: RegistryChange[];
  /** Addresses in `next` that must NOT be treated as canonical until a human accepts them. */
  untrustedAddresses: Set<string>;
  identityChangeCount: number;
}

const lc = (a: string) => a.toLowerCase();

export function diffRegistries(base: readonly StockRegistryEntry[], next: readonly StockRegistryEntry[]): RegistryDiff {
  const changes: RegistryChange[] = [];
  const untrusted = new Set<string>();
  const baseByUid = new Map(base.map((e) => [e.uid, e]));
  const baseByAddr = new Map(base.map((e) => [lc(e.address), e]));
  const baseBySymbol = new Map(base.map((e) => [e.symbol, e]));
  const nextUids = new Set(next.map((e) => e.uid));
  const nextAddrs = new Set(next.map((e) => lc(e.address)));

  const push = (c: RegistryChange) => {
    changes.push(c);
    if (c.identity) untrusted.add(lc(c.addresses[0]!));
  };

  for (const n of next) {
    const byUid = baseByUid.get(n.uid);
    const byAddr = baseByAddr.get(lc(n.address));
    if (byUid && lc(byUid.address) !== lc(n.address)) {
      push({ kind: "ADDRESS_CHANGED", identity: true, symbol: n.symbol, addresses: [n.address, byUid.address], before: byUid.address, after: n.address });
      continue;
    }
    if (byAddr && byAddr.uid !== n.uid) {
      push({ kind: "UID_CHANGED", identity: true, symbol: n.symbol, addresses: [n.address], before: byAddr.uid, after: n.uid });
      continue;
    }
    if (!byUid && !byAddr) {
      const prevOwner = baseBySymbol.get(n.symbol);
      if (prevOwner) {
        // The ticker belonged to another contract in the baseline and now names a new one.
        push({ kind: "SYMBOL_REASSIGNED", identity: true, symbol: n.symbol, addresses: [n.address, prevOwner.address], before: prevOwner.address, after: n.address });
      } else {
        push({ kind: "ADDED", identity: false, symbol: n.symbol, addresses: [n.address], before: null, after: n.address });
      }
      continue;
    }
    const b = byUid!;
    if (b.decimals !== n.decimals) {
      push({ kind: "DECIMALS_CHANGED", identity: true, symbol: n.symbol, addresses: [n.address], before: String(b.decimals), after: String(n.decimals) });
      continue;
    }
    const meta: [string, string | null, string | null][] = [
      ["symbol", b.symbol, n.symbol],
      ["name", b.name, n.name],
      ["isin", b.isin, n.isin],
      ["logoUrl", b.logoUrl, n.logoUrl],
    ];
    for (const [field, before, after] of meta) {
      if (before !== after) {
        push({ kind: "METADATA_CHANGED", identity: false, symbol: n.symbol, addresses: [n.address], before: `${field}=${before}`, after: `${field}=${after}` });
      }
    }
    if (b.multiplierE18 !== n.multiplierE18) {
      push({ kind: "MULTIPLIER_CHANGED", identity: false, symbol: n.symbol, addresses: [n.address], before: b.multiplierE18.toString(), after: n.multiplierE18.toString() });
    }
    if (b.pendingMultiplierE18 !== n.pendingMultiplierE18 || b.pendingEffectiveAt !== n.pendingEffectiveAt) {
      push({
        kind: "PENDING_MULTIPLIER_CHANGED",
        identity: false,
        symbol: n.symbol,
        addresses: [n.address],
        before: `${b.pendingMultiplierE18 ?? "none"}@${b.pendingEffectiveAt ?? "-"}`,
        after: `${n.pendingMultiplierE18 ?? "none"}@${n.pendingEffectiveAt ?? "-"}`,
      });
    }
  }
  for (const b of base) {
    if (!nextUids.has(b.uid) && !nextAddrs.has(lc(b.address))) {
      push({ kind: "REMOVED", identity: false, symbol: b.symbol, addresses: [b.address], before: b.address, after: null });
    }
  }
  return { changes, untrustedAddresses: untrusted, identityChangeCount: changes.filter((c) => c.identity).length };
}
