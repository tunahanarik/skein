/** Minimal history router: /, /terminal, /asset/:ref, /wallet, /markets, /bridge, /coverage, /compare?a=&b=, /about. The wallet address is never in the URL. */
import { useEffect, useState } from "react";

export type Route = { name: "home" } | { name: "terminal" } | { name: "asset"; ref: string } | { name: "wallet" } | { name: "markets" } | { name: "bridge" } | { name: "coverage" } | { name: "compare" } | { name: "about" } | { name: "notfound" };

export function parse(pathname: string): Route {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/") return { name: "home" };
  if (p === "/wallet") return { name: "wallet" };
  if (p === "/terminal") return { name: "terminal" };
  if (p === "/bridge") return { name: "bridge" };
  if (p === "/markets") return { name: "markets" };
  if (p === "/coverage") return { name: "coverage" };
  if (p === "/about") return { name: "about" };
  if (p === "/compare") return { name: "compare" };
  const m = /^\/asset\/([^/]+)$/.exec(p);
  if (m) {
    try {
      return { name: "asset", ref: decodeURIComponent(m[1]!) };
    } catch {
      return { name: "notfound" };
    }
  }
  return { name: "notfound" };
}

export function navigate(to: string): void {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.pathname));
  useEffect(() => {
    const on = () => setRoute(parse(location.pathname));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  return route;
}

/** Internal link that uses the router. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: { preventDefault: () => void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button?: number }) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || (e.button ?? 0) !== 0) return;
      e.preventDefault();
      navigate(to);
    },
  };
}
