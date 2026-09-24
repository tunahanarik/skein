import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: `pnpm web:dev` (Vite on :5173) proxies /api to `pnpm serve` (:8787).
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, target: "es2022" },
  server: { port: 5173, strictPort: true, proxy: { "/api": "http://127.0.0.1:8787" } },
});
