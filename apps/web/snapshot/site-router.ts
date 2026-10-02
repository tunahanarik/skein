/**
 * In-memory stand-in for src/router.ts in the site snapshot: pages change without touching the
 * address bar (the artifact frame owns it). A bare #token in the link opens a page: #markets,
 * #terminal, #wallet, #tracked, #coverage, #compare, #about, #asset-NVDA.
 */
import { useEffect, useState } from "react";
import { parse, type Route } from "../src/router";

export { parse };
export type { Route };

const PAGES = new Set(["markets", "terminal", "wallet", "tracked", "coverage", "compare", "about"]);

function startPath(): string {
  const h = location.hash.slice(1);
  if (h.startsWith("asset-")) return `/asset/${h.slice(6)}`;
  return PAGES.has(h) ? `/${h}` : "/";
}

let path = startPath();
const listeners = new Set<() => void>();
const routeOf = (p: string) => parse(p.split(/[?#]/)[0]!);

export function navigate(to: string): void {
  if (to === path) return;
  path = to;
  listeners.forEach((l) => l());
  window.scrollTo(0, 0);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => routeOf(path));
  useEffect(() => {
    const on = () => setRoute(routeOf(path));
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  return route;
}

/** Internal link that uses the router. */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: { preventDefault: () => void }) => {
      e.preventDefault();
      navigate(to);
    },
  };
}
