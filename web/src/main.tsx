import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { applyStoredTheme } from "./theme";

// One-time move of UI preferences from earlier product names ("waypoint.*", then "hoodmap.*").
try {
  for (const k of ["lang", "theme", "alerts", "watchlist", "markets.view"]) {
    for (const prev of ["waypoint", "hoodmap"]) {
      const old = localStorage.getItem(`${prev}.${k}`);
      if (old !== null && localStorage.getItem(`skein.${k}`) === null) localStorage.setItem(`skein.${k}`, old);
      localStorage.removeItem(`${prev}.${k}`);
    }
  }
} catch {
  /* storage unavailable */
}

applyStoredTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
