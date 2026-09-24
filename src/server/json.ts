/** JSON over the wire: bigints become decimal strings (exact; never floats). */
import type { ServerResponse } from "node:http";

export type { Wire } from "./wire.js";

export const toJson = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

export function sendJson(res: ServerResponse, status: number, body: unknown, cache: string, headOnly = false): void {
  const text = toJson(body);
  res.statusCode = status;
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.setHeader("Content-Length", Buffer.byteLength(text));
  res.end(headOnly ? undefined : text);
}
