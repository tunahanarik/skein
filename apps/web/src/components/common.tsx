import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiFailure, logoUrl, type AssetListItem } from "../api";
import { explorerAddress } from "../format";
import { useI18n } from "../i18n";
import { code } from "../text";

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

/** External explorer link for a contract address (new tab, no referrer). */
export function ExplorerLink({ address, children }: { address: string; children?: ReactNode }) {
  const { t } = useI18n();
  const href = explorerAddress(address);
  if (!href) return <span className="mono">{children ?? address}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="mono" title={t("misc.explorer")}>
      {children ?? address} ↗
    </a>
  );
}

/** Link to a protocol's own app (URL already passed the server allowlist; re-checked here). */
export function ProtocolLink({ name, url }: { name: string; url: string }) {
  const { t } = useI18n();
  if (!/^https:\/\/[a-z0-9.-]+\//i.test(url)) return null;
  return (
    <div className="small">
      <a className="proto-link" href={url} target="_blank" rel="noopener noreferrer" title={t("link.note")}>
        {t("link.open", { p: name })} ↗
      </a>
    </div>
  );
}

const failedLogos = new Set<string>();

/** Token logo served by our own API (canonical assets only); falls back to a monogram. */
/** Static icons that read better than the source logo (WETH shows the ETH mark, as bridges and wallets do). */
const STATIC_LOGOS: Record<string, string> = { "0x0bd7d308f8e1639fab988df18a8011f41eacad73": "/tokens/weth.svg" };

export function Avatar({ symbol, address, size }: { symbol: string; address?: string | null; size?: "lg" }) {
  // Failure is remembered per address, so an avatar that first renders without an address
  // (data still loading) still shows the logo once the address arrives.
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const failed = !address || failedLogos.has(address.toLowerCase()) || failedFor === address.toLowerCase();
  const cls = `avatar${size === "lg" ? " lg" : ""}`;
  const fixed = address ? STATIC_LOGOS[address.toLowerCase()] : undefined;
  if (fixed) return <img className={`${cls} logo`} src={fixed} alt="" decoding="async" />;
  if (!failed && address && /^0x[0-9a-fA-F]{40}$/.test(address)) {
    return (
      <img
        className={`${cls} logo`}
        src={logoUrl(address)}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => {
          failedLogos.add(address.toLowerCase());
          setFailedFor(address.toLowerCase());
        }}
      />
    );
  }
  return (
    <span className={cls} aria-hidden="true">
      {symbol.slice(0, 4)}
    </span>
  );
}

export function UsabilityBadge({ status }: { status: string }) {
  const { t } = useI18n();
  return <span className={`badge ${status}`}>{code(t, "use", status)}</span>;
}

export function Skeleton({ h = 16, w = "100%" }: { h?: number; w?: number | string }) {
  return <div className="skeleton" style={{ height: h, width: w }} />;
}

export function LoadingCards({ n = 4 }: { n?: number }) {
  const { t } = useI18n();
  return (
    <div className="grid two" aria-busy="true" aria-label={t("misc.loading")}>
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

export function ErrorBox({ error, onRetry }: { error: ApiFailure; onRetry?: () => void }) {
  const { t } = useI18n();
  const known = code(t, "err", error.code);
  return (
    <div className="notice bad" role="alert">
      <div>
        <strong>{known !== error.code ? known : error.message}</strong>
        {onRetry && (
          <div style={{ marginTop: 8 }}>
            <button className="btn small" onClick={onRetry}>
              {t("err.retry")}
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
