/**
 * Light/dark theme. Dark is the product's default look; choosing light sets data-theme on <html>
 * and is remembered in localStorage (a UI preference; failures ignored).
 */
import { useCallback, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "hoodmap.theme";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

/** Apply the remembered theme before the first render (no inline script: the CSP forbids it). */
export function applyStoredTheme(): void {
  const t = stored();
  if (t) document.documentElement.dataset.theme = t;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? "dark");
  const toggle = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem(KEY, next);
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return { theme, toggle };
}
