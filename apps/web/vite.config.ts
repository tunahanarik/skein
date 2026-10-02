import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: `pnpm web:dev` (Vite on :5173) proxies /api to `pnpm serve` (:8787).
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  // Fonts are never inlined as data: URLs: the CSP allows fonts from 'self' only.
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022", assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined) },
  // Scan only the app entry: snapshot/ has its own config and a virtual module the scanner cannot resolve.
  optimizeDeps: { entries: ["index.html"] },
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:8787" } },
});
