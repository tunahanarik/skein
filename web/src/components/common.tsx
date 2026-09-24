import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiFailure, type AssetListItem } from "../api";
import { USABILITY_LABEL } from "../text";

/** Fetch with abort on dependency change. */
export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: ApiFailure | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    const ac = new AbortController();
    setState((s) => ({ data: s.data, error: null, loading: true }));
    fnRef.current(ac.signal).then(
      (data) => !ac.signal.aborted && setState({ data, error: null, loading: false }),
      (e) => {
        if (ac.signal.aborted || (e as Error).name === "AbortError") return;
        setState({ data: null, error: e instanceof ApiFailure ? e : new ApiFailure(0, "ERROR", (e as Error).message), loading: false });
      },
    );
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

let assetListPromise: Promise<AssetListItem[]> | null = null;
/** The canonical asset list, fetched once per page load. */
export function useAssetList(): AssetListItem[] | null {
  const [list, setList] = useState<AssetListItem[] | null>(null);
  useEffect(() => {
    assetListPromise ??= api.assets().then((r) => r.assets).catch((e) => {
      assetListPromise = null;
      throw e;
    });
    let live = true;
    assetListPromise.then((l) => live && setList(l), () => live && setList([]));
    return () => {
      live = false;
    };
  }, []);
  return list;
}

export function Avatar({ symbol, size }: { symbol: string; size?: "lg" }) {
  return (
    <span className={`avatar${size === "lg" ? " lg" : ""}`} aria-hidden="true">
      {symbol.slice(0, 4)}
    </span>
  );
}

export function UsabilityBadge({ status }: { status: string }) {
  return <span className={`badge ${status}`}>{USABILITY_LABEL[status] ?? status}</span>;
}

export function Skeleton({ h = 16, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

export function LoadingCards({ n = 4 }: { n?: number }) {
  return (
    <div className="grid two" aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="panel card">
          <Skeleton h={18} w="60%" />
          <Skeleton h={28} w="35%" />
          <Skeleton h={12} w="80%" />
        </div>
      ))}
    </div>
  );
}

const ERROR_TEXT: Record<string, string> = {
  RATE_LIMITED: "Too many requests. Wait a few seconds and try again.",
  NETWORK: "The server could not be reached.",
  UNKNOWN_ASSET: "This asset is not in the verified registry.",
  AMBIGUOUS_SYMBOL: "Several assets share this symbol. Open it by contract address instead.",
  BAD_ADDRESS: "That is not a valid address.",
  INTERNAL: "Something went wrong on the server.",
};

export function ErrorBox({ error, onRetry }: { error: ApiFailure; onRetry?: () => void }) {
  return (
    <div className="notice bad" role="alert">
      <div>
        <strong>{ERROR_TEXT[error.code] ?? error.message}</strong>
        {onRetry && (
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Notice({ kind, children }: { kind: "warn" | "info" | "bad" | "ok"; children: ReactNode }) {
  return <div className={`notice ${kind}`}>{children}</div>;
}
