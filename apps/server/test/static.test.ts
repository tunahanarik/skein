import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStatic, isOriginForm } from "../src/static.js";

describe("static server", () => {
  let dir: string;
  let server: Server;
  let port = 0;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "skein-static-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Skein</title>");
    writeFileSync(join(dir, "assets", "app.js"), "x".repeat(256 * 1024));
    const serve = createStatic(dir);
    server = createServer((req, res) => {
      if (!isOriginForm(req.url)) {
        res.statusCode = 400;
        return void res.end();
      }
      if (!serve(req, res)) {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const a = server.address();
    port = typeof a === "object" && a ? a.port : 0;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  /** A raw request, so malformed targets reach the server exactly as written. */
  const raw = (target: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: target, method: "GET" }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });

  it("only origin-form targets are parsed", () => {
    expect(isOriginForm("/wallet")).toBe(true);
    expect(isOriginForm("//a:b")).toBe(false);
    expect(isOriginForm("http://evil/x")).toBe(false);
    expect(isOriginForm(undefined)).toBe(false);
  });

  it("a '//a:b' target gets a 400 and the server keeps answering (SRV-1)", async () => {
    expect(await raw("//a:b")).toBe(400);
    expect(await raw("/")).toBe(200);
  });

  it("serves files, falls back to the shell for routes, 404s missing assets and traversal", async () => {
    expect(await raw("/assets/app.js")).toBe(200);
    expect(await raw("/wallet")).toBe(200);
    expect(await raw("/missing.js")).toBe(404);
    expect(await raw("/../../etc/passwd")).not.toBe(500);
  });

  it("a client that disconnects mid-download does not break later requests (SRV-2)", async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise<void>((resolve) => {
        const req = request({ host: "127.0.0.1", port, path: "/assets/app.js" }, (res) => {
          res.once("data", () => {
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => resolve());
        req.end();
      });
    }
    expect(await raw("/assets/app.js")).toBe(200);
  });
});
