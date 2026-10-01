import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { launch } from "./cdp.mjs";
const mode = process.argv[2] ?? "frames";
const b = await launch({ width: 1080, height: 1080 });
await b.send("Page.enable");
await b.send("Page.navigate", { url: pathToFileURL(resolve("skein-intro.html")).href });
for (let i = 0; i < 50; i++) { try { if (await b.evaluate("window.ready ? window.ready.then(() => true) : false")) break; } catch {} await new Promise((r) => setTimeout(r, 200)); }
if (mode === "frames") {
  mkdirSync("frames", { recursive: true });
  const times = (process.argv[3] ?? "2.8,5.5,10.8,16.5,19.9,23").split(",").map(Number);
  for (const t of times) {
    await b.evaluate(`draw(${t})`);
    const s = await b.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`frames/t${String(t).replace(".", "_")}.png`, Buffer.from(s.data, "base64"));
    console.log("frame", t);
  }
} else {
  const size = await b.evaluate("record(30)");
  const parts = [];
  for (let i = 0; i < size; i += 1 << 21) parts.push(Buffer.from(await b.evaluate(`chunk(${i}, ${1 << 21})`), "base64"));
  writeFileSync("skein-intro.mp4", Buffer.concat(parts));
  console.log("mp4 bytes", size);
}
b.close();
