import "./site-shims";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import data from "virtual:skein-site";
import { App } from "../src/App";
import { applyStoredTheme } from "../src/theme";
import "../src/styles/index.css";
import "./snapshot.css";

applyStoredTheme();

const when = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(new Date(data.capturedAt));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="snap-note" role="note">
      Static snapshot of the redesigned site, data captured {when} UTC from Robinhood Chain. Full detail for {data.detailed.join(", ")}. Prices do not update and wallet connect is off.
      {data.sampleWallet && (
        <>
          {" "}
          Sample address to paste: <span className="mono">{data.sampleWallet}</span> (an NVDA pool contract).
        </>
      )}
    </div>
    <App />
  </StrictMode>,
);
