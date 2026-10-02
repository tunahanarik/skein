import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "test/integration/**/*.test.ts", "apps/web/src/**/*.test.{ts,tsx}"],
    // Unit tests live next to their package (packages/*/test, apps/*/test); cross-package
    // integration tests in test/integration. All are offline; live checks are apps/cli/src/validate-*.ts.
    // Web UI tests opt into jsdom per file (`// @vitest-environment jsdom`).
    environment: "node",
  },
});
