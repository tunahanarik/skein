/**
 * Refresh the committed Stock Token registry snapshot from the live API.
 *
 *   pnpm registry:snapshot                          # show diff; write only if no identity changes
 *   pnpm registry:snapshot --accept-identity-changes  # after a human reviewed the diff
 *   pnpm registry:snapshot --check                   # diff only, never write (CI)
 *
 * Identity changes (address/uid/decimals/symbol reassignment) are never written silently.
 */
import { existsSync } from "node:fs";
import { HttpClient } from "@skein/core/lib/http";
import { diffRegistries } from "@skein/robinhood/registry/diff";
import { fetchRobinhoodAssetRegistry, validateRobinhoodAssetRegistry } from "@skein/robinhood/registry/robinhoodRegistry";
import { buildSnapshot, defaultSnapshotPath, readSnapshotFile, writeSnapshotFile } from "@skein/robinhood/registry/snapshot";

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const accept = args.has("--accept-identity-changes");

const raw = await fetchRobinhoodAssetRegistry(new HttpClient());
const v = validateRobinhoodAssetRegistry(raw);
console.log(`live: ${raw.assets.length} upstream assets → ${v.entries.length} canonical entries (${raw.bytes} B, fetched ${raw.fetchedAt})`);
for (const i of v.issues) console.log(`  issue ${i.code} [${i.effect}] ${i.subject}: ${i.detail}`);

const snapshotPath = defaultSnapshotPath();
const base = existsSync(snapshotPath) ? readSnapshotFile() : null;
if (base) {
  const d = diffRegistries(base.entries, v.entries);
  console.log(`vs snapshot ${base.contentHash} (${base.generatedAt}): ${d.changes.length} changes, ${d.identityChangeCount} identity`);
  for (const c of d.changes) console.log(`  ${c.identity ? "IDENTITY " : ""}${c.kind} ${c.symbol} ${c.addresses.join(" / ")}: ${c.before} → ${c.after}`);
  if (check) process.exit(d.identityChangeCount > 0 ? 1 : 0);
  if (d.identityChangeCount > 0 && !accept) {
    console.error("refusing to write: identity changes need review (re-run with --accept-identity-changes)");
    process.exit(1);
  }
  if (d.changes.length === 0) {
    console.log("snapshot already current; not rewritten");
    process.exit(0);
  }
} else {
  console.log("no existing snapshot: bootstrapping baseline");
  if (check) process.exit(1);
}
const snap = buildSnapshot(v.entries, raw.fetchedAt);
writeSnapshotFile(snap);
console.log(`wrote ${snapshotPath}: ${snap.assetCount} entries, ${snap.contentHash}`);
