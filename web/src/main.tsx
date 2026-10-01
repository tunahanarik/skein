import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter-tight";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { applyStoredTheme } from "./theme";

// One-time move of UI preferences from the old product name ("waypoint.*" keys).
try {
  for (const k of ["lang", "theme", "alerts", "watchlist"]) {
    const old = localStorage.getItem(`waypoint.${k}`);
    if (old !== null && localStorage.getItem(`hoodmap.${k}`) === null) localStorage.setItem(`hoodmap.${k}`, old);
    localStorage.removeItem(`waypoint.${k}`);
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
