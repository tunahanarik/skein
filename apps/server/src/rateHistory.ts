/**
 * Local rate history: protocols give no rate history for Robinhood Chain, so the server records the
 * headline rate and TVL of every default-eligible opportunity from its own snapshots — at most once
 * per RECORD_EVERY_MS — in an append-only JSONL file (.cache, gitignored). History therefore
 * starts when recording started and has gaps while the server is off; the API says so.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Opportunity } from "@skein/core/model/opportunity";
import { headlineMetric } from "@skein/engine/opportunities/headline";

export const RECORD_EVERY_MS = 10 * 60_000;
export const RETENTION_MS = 30 * 24 * 3600_000;
const MAX_POINTS_PER_ID = 5_000;

export interface RatePoint {
  t: number; // unix ms
  v: string; // headline rate, 1e18 fixed as decimal string
  tvl: string | null; // USD e18 as decimal string
}

export class RateHistory {
  private readonly byId = new Map<string, RatePoint[]>();
  private lastRecord = 0;
  private startedAt: number | null = null;

  constructor(private readonly file: string | null, private readonly now: () => number = Date.now) {
    if (file && existsSync(file)) {
      const cutoff = this.now() - RETENTION_MS;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const r = JSON.parse(line) as { t: number; id: string; v: string; tvl: string | null };
          if (typeof r.t !== "number" || typeof r.id !== "string" || !/^-?\d+$/.test(r.v) || r.t < cutoff) continue;
          this.push(r.id, { t: r.t, v: r.v, tvl: r.tvl });
          this.startedAt = Math.min(this.startedAt ?? r.t, r.t);
        } catch {
          /* skip a torn line */
        }
      }
      this.compact();
    }
  }

  private push(id: string, p: RatePoint): void {
    const a = this.byId.get(id) ?? [];
    a.push(p);
    if (a.length > MAX_POINTS_PER_ID) a.shift();
    this.byId.set(id, a);
  }

  /** Rewrite the file without expired points (at load). */
  private compact(): void {
    if (!this.file) return;
    const lines = [...this.byId].flatMap(([id, ps]) => ps.map((p) => JSON.stringify({ t: p.t, id, v: p.v, tvl: p.tvl })));
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, lines.length ? lines.join("\n") + "\n" : "");
  }

  /** Record a snapshot (throttled). Only default-eligible opportunities with a headline rate. */
  record(opps: readonly Opportunity[], takenAt: number = this.now()): number {
    if (takenAt - this.lastRecord < RECORD_EVERY_MS) return 0;
    this.lastRecord = takenAt;
    this.startedAt ??= takenAt;
    const lines: string[] = [];
    for (const o of opps) {
      if (!o.eligibility?.eligibleForDefaultDisplay) continue;
      const h = headlineMetric(o);
      if (!h) continue;
      const p: RatePoint = { t: takenAt, v: h.value.toString(), tvl: o.tvl?.value.usd?.e18.toString() ?? null };
      this.push(o.id, p);
      lines.push(JSON.stringify({ t: p.t, id: o.id, v: p.v, tvl: p.tvl }));
    }
    if (this.file && lines.length) {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, lines.join("\n") + "\n");
    }
    return lines.length;
  }

  get(id: string): { points: RatePoint[]; recordingSince: string | null; everyMinutes: number } {
    return { points: [...(this.byId.get(id) ?? [])], recordingSince: this.startedAt ? new Date(this.startedAt).toISOString() : null, everyMinutes: RECORD_EVERY_MS / 60_000 };
  }
}
