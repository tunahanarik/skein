import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts", "web/src/**/*.test.tsx"],
    // unit + integration tests are offline; live checks live in scripts/validate-*.ts.
    // Web UI tests opt into jsdom per file (`// @vitest-environment jsdom`).
    environment: "node",
  },
});
