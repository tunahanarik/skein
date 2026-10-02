import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/index.css";
import { applyStoredTheme } from "./theme";

// One-time move of UI preferences from earlier product names ("waypoint.*", then "hoodmap.*").
try {
  for (const k of ["theme", "alerts", "watchlist", "markets.view"]) {
    for (const prev of ["waypoint", "hoodmap"]) {
      const old = localStorage.getItem(`${prev}.${k}`);
      if (old !== null && localStorage.getItem(`skein.${k}`) === null) localStorage.setItem(`skein.${k}`, old);
      localStorage.removeItem(`${prev}.${k}`);
    }
  }
  // The site is English only now; drop the old language choice.
  localStorage.removeItem("skein.lang");
} catch {
  /* storage unavailable */
}

applyStoredTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
