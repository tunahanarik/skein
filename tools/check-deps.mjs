// Workspace dependency rules. Run: pnpm check:deps
//   1. every @skein/* or third-party import in src/ is declared in that package's package.json
//   2. no cycles between packages (src imports only; tests may use anything the root declares)
//   3. libraries (packages/*) never import apps (apps/*)
//   4. @skein/core and @skein/networks import no other @skein package and @skein/chain only those two,
//      so the foundation stays reusable on any chain; packages in BROWSER_SAFE import no node:*
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const LEAF_RULES = {
  "@skein/networks": [],
  "@skein/core": [],
  "@skein/chain": ["@skein/networks", "@skein/core"],
};
/** Packages that must also run in the browser (none today). */
const BROWSER_SAFE = new Set([]);

const pkgs = ["packages", "apps"].flatMap((g) =>
  readdirSync(join(root, g)).map((n) => {
    const dir = join(root, g, n);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return { group: g, dir, name: manifest.name, declared: new Set(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) };
  }),
);
const apps = new Set(pkgs.filter((p) => p.group === "apps").map((p) => p.name));

const walk = (d, out = []) => {
  for (const e of readdirSync(d)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
};

const errors = [];
const graph = {};
for (const p of pkgs) {
  graph[p.name] = new Set();
  let files = [];
  try { files = walk(join(p.dir, "src")); } catch { continue; }
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const specs = /^\s*(?:import|export)\s[^;]*?\bfrom\s+["']([^"'.][^"']*)["']|^\s*import\s+["']([^"'.][^"']*)["']|\bimport\(\s*["']([^"'.][^"']*)["']\s*\)/gm;
    for (const m of text.matchAll(specs)) {
      const spec = m[1] ?? m[2] ?? m[3];
      const rel = f.slice(root.length).split(sep).join("/");
      if (spec.startsWith("node:")) {
        if (BROWSER_SAFE.has(p.name)) errors.push(`${rel}: ${p.name} must stay browser-safe but imports ${spec}`);
        continue;
      }
      const dep = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
      if (dep === p.name) continue;
      if (!p.declared.has(dep)) errors.push(`${rel}: imports ${dep}, not declared in ${p.name}/package.json`);
      if (!dep.startsWith("@skein/")) continue;
      graph[p.name].add(dep);
      if (p.group === "packages" && apps.has(dep)) errors.push(`${rel}: library ${p.name} imports app ${dep}`);
      const allowed = LEAF_RULES[p.name];
      if (allowed && !allowed.includes(dep)) errors.push(`${rel}: ${p.name} may only import ${allowed.join(", ") || "no @skein package"}, found ${dep}`);
    }
  }
}

const state = {};
const stack = [];
const visit = (n) => {
  state[n] = 1;
  stack.push(n);
  for (const m of graph[n] ?? []) {
    if (state[m] === 1) errors.push(`cycle: ${[...stack.slice(stack.indexOf(m)), m].join(" -> ")}`);
    else if (!state[m]) visit(m);
  }
  state[n] = 2;
  stack.pop();
};
for (const n of Object.keys(graph)) if (!state[n]) visit(n);

if (errors.length) {
  console.error([...new Set(errors)].join("\n"));
  process.exit(1);
}
console.log(`ok: ${pkgs.length} packages, no undeclared imports, no cycles`);
