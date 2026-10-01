import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { launch } from "./cdp.mjs";
const b = await launch({ width: 1080, height: 1080 });
await b.send("Page.enable");
await b.send("Page.navigate", { url: pathToFileURL(resolve("player.html")).href });
await new Promise((r) => setTimeout(r, 500));
const url = pathToFileURL(resolve(process.argv[2])).href;
const info = await b.evaluate(`(async () => {
  document.body.style.margin = 0; document.body.style.background = "#000";
  const v = document.createElement("video"); v.src = ${JSON.stringify(url)}; v.muted = true; v.style.width = "1080px"; v.style.height = "1080px"; document.body.append(v);
  await new Promise((r, j) => { v.onloadedmetadata = r; v.onerror = () => j(new Error("video error " + (v.error && v.error.code))); });
  return { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
})()`);
console.log(info);
mkdirSync("check", { recursive: true });
for (const t of [1, 6, 11, 16, 19, 23.5]) {
  await b.evaluate(`(async () => { const v = document.querySelector("video"); v.currentTime = ${t}; await new Promise(r => v.onseeked = r); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); })()`);
  const s = await b.send("Page.captureScreenshot", { format: "jpeg", quality: 70 });
  writeFileSync(`check/v${String(t).replace(".", "_")}.jpg`, Buffer.from(s.data, "base64"));
}
console.log("ok");
b.close();
