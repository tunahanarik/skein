/** Tiny check recorder: every script prints PASS/FAIL/WARN lines and writes a JSON snapshot. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "INFO";

/** Origin only (a provider URL can carry an API key in its path or query). */
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : "/…"}`;
  } catch {
    return "invalid-url";
  }
}

/**
 * Configured RPC URLs never reach a report (reports are committed under research/snapshots):
 * every occurrence is cut to its origin, whichever check printed it (A1).
 */
export function scrubSecrets(s: string): string {
  for (const url of [process.env.ROBINHOOD_RPC_URL, process.env.ROBINHOOD_INDEX_RPC_URL]) {
    if (url && url.length > 8) s = s.split(url).join(originOf(url));
  }
  return s;
}

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  evidence?: Record<string, unknown>;
}

export class Report {
  readonly checks: Check[] = [];
  readonly startedAt = new Date().toISOString();

  constructor(readonly name: string) {}

  add(status: CheckStatus, name: string, detail: string, evidence?: Record<string, unknown>): void {
    this.checks.push({ name, status, detail, ...(evidence ? { evidence } : {}) });
    const tag = { PASS: "PASS", FAIL: "FAIL", WARN: "WARN", INFO: "INFO" }[status];
    console.log(scrubSecrets(`${tag.padEnd(4)}  ${name} — ${detail}`));
  }

  pass(name: string, detail: string, evidence?: Record<string, unknown>) {
    this.add("PASS", name, detail, evidence);
  }
  fail(name: string, detail: string, evidence?: Record<string, unknown>) {
    this.add("FAIL", name, detail, evidence);
  }
  warn(name: string, detail: string, evidence?: Record<string, unknown>) {
    this.add("WARN", name, detail, evidence);
  }
  info(name: string, detail: string, evidence?: Record<string, unknown>) {
    this.add("INFO", name, detail, evidence);
  }

  get failed(): number {
    return this.checks.filter((c) => c.status === "FAIL").length;
  }

  /** Writes research/snapshots/<name>.json (bigints as strings) and returns the exit code. */
  finish(): number {
    const dir = join(process.cwd(), "research", "snapshots");
    mkdirSync(dir, { recursive: true });
    const out = { script: this.name, startedAt: this.startedAt, finishedAt: new Date().toISOString(), checks: this.checks };
    writeFileSync(
      join(dir, `${this.name}.json`),
      JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : typeof v === "string" ? scrubSecrets(v) : v), 2) + "\n",
    );
    const counts = this.checks.reduce<Record<string, number>>((m, c) => ((m[c.status] = (m[c.status] ?? 0) + 1), m), {});
    console.log(`\n${this.name}: ${JSON.stringify(counts)}`);
    return this.failed > 0 ? 1 : 0;
  }
}
