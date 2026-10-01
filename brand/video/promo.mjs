// node promo.mjs frames 3.2,10,...  -> stills in frames/   |   node promo.mjs encode -> skein-promo.mp4
import { writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { launch } from "./cdp.mjs";
import { serve } from "./serve.mjs";
const mode = process.argv[2] ?? "frames";
const srv = await serve();
const b = await launch({ width: 1920, height: 1080 });
await b.send("Page.enable");
await b.send("Page.navigate", { url: "http://localhost:8799/brand/video/promo.html" });
for (let i = 0; i < 100; i++) { try { if (await b.evaluate("window.ready ? window.ready.then(() => true) : false")) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
if (mode === "frames") {
  mkdirSync("frames", { recursive: true });
  for (const t of (process.argv[3] ?? "1.5,3.6,6.5,10.5,14.8,19.8,24.4,28,33").split(",").map(Number)) {
    await b.evaluate(`draw(${t})`);
    const s = await b.send("Page.captureScreenshot", { format: "jpeg", quality: 85 });
    writeFileSync(`frames/p${String(t).replace(".", "_")}.jpg`, Buffer.from(s.data, "base64"));
  }
  console.log("frames ok");
} else {
  const t0 = Date.now();
  console.log(await b.evaluate("encode(60)"), "in", Math.round((Date.now() - t0) / 1000), "s");
  const meta = await b.evaluate("window.meta");
  const total = meta.sizes.reduce((a, c) => a + c, 0), parts = [];
  for (let i = 0; i < total; i += 1 << 21) parts.push(Buffer.from(await b.evaluate(`chunk(${i}, ${1 << 21})`), "base64"));
  writeFileSync("promo.bin", Buffer.concat(parts)); writeFileSync("promo.json", JSON.stringify(meta));
  console.log(execFileSync("python", ["mux.py", "promo.bin", "promo.json", "skein-promo.mp4"]).toString().trim());
}
b.close(); srv.close();
