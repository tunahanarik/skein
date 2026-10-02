/**
 * One key per API request in the site snapshot, shared by the capture (vite.config.ts) and the
 * replay (site-shims.ts): asset refs become lower-case addresses, as the server resolves them, and
 * query parameters are sorted.
 */
export function makeKeyOf(assets: readonly { symbol: string; address: string }[]) {
  const ref = (raw: string): string => {
    const r = decodeURIComponent(raw).toLowerCase();
    if (/^0x[0-9a-f]{40}$/.test(r)) return r;
    const hits = assets.filter((a) => a.symbol.toLowerCase() === r);
    return hits.length === 1 ? hits[0]!.address.toLowerCase() : r;
  };
  return (pathname: string, search = ""): string => {
    const q = new URLSearchParams(search);
    q.sort();
    let p = pathname;
    const asset = /^\/api\/assets\/([^/]+)(\/.*)?$/.exec(p);
    if (asset) p = `/api/assets/${ref(asset[1]!)}${asset[2] ?? ""}`;
    const wallet = /^\/api\/portfolio\/([^/]+)$/.exec(p);
    if (wallet) p = `/api/portfolio/${decodeURIComponent(wallet[1]!).toLowerCase()}`;
    const qs = q.toString();
    return qs ? `${p}?${qs}` : p;
  };
}
