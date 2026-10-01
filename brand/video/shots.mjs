// Captures real product screens from the local site for the intro video.
import { writeFileSync } from "node:fs";
import { launch } from "./cdp.mjs";
const BASE = "http://localhost:8787";
const b = await launch({ width: 1600, height: 1000, scale: 1.5 });
await b.send("Page.enable");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function go(path, wait) { await b.send("Page.navigate", { url: BASE + path }); await sleep(wait); }
async function shot(name, full = false) {
  const p = { format: "png", captureBeyondViewport: full };
  if (full) { const h = await b.evaluate("document.documentElement.scrollHeight"); p.clip = { x: 0, y: 0, width: 1600, height: Math.min(h, 2600), scale: 1 }; }
  const s = await b.send("Page.captureScreenshot", p);
  writeFileSync(`shots/${name}.png`, Buffer.from(s.data, "base64")); console.log("shot", name);
}
await b.evaluate("localStorage.setItem('skein.lang','en')").catch(() => {});
await go("/", 6000); await shot("home");
await go("/asset/NVDA", 30000); await shot("asset", true);
await go("/markets", 8000); await shot("markets", true);
// terminal: type a command, let the options and chart load
await go("/terminal", 5000);
await b.evaluate(`(() => { const i = document.querySelector('main input'); i.focus(); })()`);
await b.send("Input.insertText", { text: "earn yield on NVDA" });
await sleep(12000); await shot("terminal");
// swap drawer over the asset page
await go("/asset/NVDA", 8000);
await b.evaluate(`[...document.querySelectorAll('header button')].find(x => /^\s*swap\s*$/i.test(x.innerText))?.click()`);
await sleep(12000); await shot("swap");
b.close();
