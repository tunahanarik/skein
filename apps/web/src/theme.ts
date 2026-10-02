/**
 * Light/dark theme. Dark is the product's default look; choosing light sets data-skein-theme on <html>
 * and is remembered in localStorage (a UI preference; failures ignored). Not data-theme: hosts such
 * as the claude.ai artifact viewer set that one from their own theme.
 */
import { useCallback, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "skein.theme";

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
  if (t) document.documentElement.dataset.skeinTheme = t;
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? "dark");
  const toggle = useCallback(() => {
    setTheme((cur) => {
      const next: Theme = cur === "dark" ? "light" : "dark";
      document.documentElement.dataset.skeinTheme = next;
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
