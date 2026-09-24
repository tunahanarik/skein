import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/unit/**/*.test.ts", "test/integration/**/*.test.ts"],
    // unit + integration tests are offline; live checks live in scripts/validate-*.ts
    environment: "node",
  },
});
